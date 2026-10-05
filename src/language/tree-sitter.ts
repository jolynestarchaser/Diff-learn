import Parser from 'tree-sitter';
import { createRequire } from 'node:module';
import JavaScript from 'tree-sitter-javascript';
import { createHash } from 'node:crypto';
import { languageCapabilities, javaLanguageCapabilities, languageForPath, type Language, type LanguageAnalyzer, type LanguageResult, type SourceRange, type SymbolObservation } from './contracts.js';
import { javaDeclaration, type Declaration } from './java.js';
// Upstream 0.23.2 has an invalid ambient export assignment under TS 6.
// Load its two opaque grammar handles without weakening project type checking.
const TypeScript = createRequire(import.meta.url)('tree-sitter-typescript') as { typescript: unknown; tsx: unknown };
export function createLanguageParser(language: Language) { const parser = new Parser(); parser.setLanguage(language === 'java' ? createRequire(import.meta.url)('tree-sitter-java') : language === 'typescript' ? TypeScript.typescript : language === 'tsx' ? TypeScript.tsx : JavaScript); parser.setTimeoutMicros(250_000); return parser; }

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Node = Parser.SyntaxNode;
function kind(node: Node): SymbolObservation['kind'] | null {
  if (!node.isNamed) return null;
  const types: Record<string, SymbolObservation['kind']> = { class_declaration: 'class', abstract_class_declaration: 'class', class: 'class', function_declaration: 'function', generator_function_declaration: 'function', function_signature: 'function', method_definition: 'method', method_signature: 'method', abstract_method_signature: 'method', interface_declaration: 'interface', type_alias_declaration: 'type-alias', enum_declaration: 'enum', internal_module: 'namespace', import_statement: 'import' };
  if (node.type === 'variable_declarator' || node.type === 'public_field_definition') { const value = node.childForFieldName('value'); return value?.type === 'arrow_function' ? 'arrow-function' : value && /function_expression/u.test(value.type) ? 'function' : 'variable'; }
  return types[node.type] ?? null;
}
export class TreeSitterAnalyzer implements LanguageAnalyzer {
  constructor(private readonly includeJava = true) {
    const require = createRequire(import.meta.url);
    for (const [name, version] of [['tree-sitter', '0.21.1'], ['tree-sitter-typescript', '0.23.2'], ['tree-sitter-javascript', '0.23.1'], ...includeJava ? [['tree-sitter-java', '0.23.5']] : []]) {
      if ((require(`${name}/package.json`) as { version: string }).version !== version) throw new Error('Installed parser/grammar version differs from the pinned compatibility contract');
    }
  }
  get capabilities() { return this.includeJava ? javaLanguageCapabilities : languageCapabilities; }
  languageForPath = (filename: string | null) => { const language = languageForPath(filename); return !this.includeJava && language === 'java' ? null : language; };
  analyze({ sources, patch, maxSymbols }: Parameters<LanguageAnalyzer['analyze']>[0]): LanguageResult {
    const result: LanguageResult = { state: 'complete', reasons: [], sources: sources.map(source => source.snapshot), symbols: [], diagnostics: [], unmappedChangedLines: 0, omittedSymbols: 0, changeInterpretation: 'syntax-only', references: 'unavailable', behavior: 'unavailable', contracts: 'unavailable' };
    const declarationCounts = new Map<string, number>();
    const matchingKey = (symbol: Pick<SymbolObservation, 'language' | 'kind' | 'name' | 'scope'>) => JSON.stringify([symbol.language, symbol.kind, symbol.name, symbol.scope]);
    const diagnostic = (code: string, side: 'before' | 'after' | null, range: SourceRange | null, message: string) => { result.reasons.push(code); result.diagnostics.push({ code, side, range, message }); };
    if (patch.state !== 'complete') diagnostic('SYMBOL_PATCH_INCOMPLETE', null, null, 'Only retained complete hunks can be mapped; patch coverage is incomplete');
    for (const { snapshot, bytes } of sources) {
      if (snapshot.origin === 'absent' && snapshot.state === 'available') continue;
      if (!snapshot.language || snapshot.state !== 'available' || !bytes) { diagnostic(snapshot.reason ?? 'SYMBOL_LANGUAGE_UNSUPPORTED', snapshot.side, null, 'Source side unavailable for declaration analysis'); continue; }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (!Buffer.from(text).equals(bytes) || bytes.includes(0)) throw new Error(); }
      catch { diagnostic('SYMBOL_SOURCE_ENCODING', snapshot.side, null, 'Only lossless UTF-8 source without NUL is analyzed'); continue; }
      const lineStarts = [0]; for (let index = 0; index < text.length; index++) if (text[index] === '\n') lineStarts.push(index + 1);
      const byteOffsets = new Uint32Array(text.length + 1); let byteOffset = 0;
      for (let index = 0; index < text.length;) { const point = text.codePointAt(index)!; const units = point > 0xffff ? 2 : 1; if (units === 2) byteOffsets[index + 1] = byteOffset; byteOffset += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; index += units; byteOffsets[index] = byteOffset; }
      const range = (node: Node): SourceRange => ({ startByte: byteOffsets[node.startIndex]!, endByte: byteOffsets[node.endIndex]!, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, startColumn: byteOffsets[node.startIndex]! - byteOffsets[lineStarts[node.startPosition.row]!]!, endColumn: byteOffsets[node.endIndex]! - byteOffsets[lineStarts[node.endPosition.row]!]! });
      const changed = patch.hunks.flatMap(hunk => hunk.lines.filter(line => snapshot.side === 'before' ? line.kind === 'remove' : line.kind === 'add').map(line => ({ number: (snapshot.side === 'before' ? line.oldLine : line.newLine)!, hunk: hunk.ordinal, bytes: line.contentBytes })));
      // Verify every retained patch line against the exact supplied side, not a later reread.
      const sourceLines = bytes.toString('utf8').split('\n');
      const mismatch = patch.hunks.some(hunk => hunk.lines.some(line => { const number = snapshot.side === 'before' ? line.oldLine : line.newLine; return number !== null && Buffer.from(sourceLines[number - 1] ?? '').toString('base64') !== line.contentBytes; }));
      if (mismatch) { diagnostic('SYMBOL_PATCH_SOURCE_MISMATCH', snapshot.side, null, 'Git patch lines differ from retained source; normalization or source disagreement prevents analysis'); continue; }
      let tree: Parser.Tree;
      try { const parser = createLanguageParser(snapshot.language); tree = parser.parse(text); if (!tree) throw new Error(); } catch { diagnostic('SYMBOL_PARSE_FAILED', snapshot.side, null, 'Parser could not load, failed or exceeded its time bound'); continue; }
      const deadline = performance.now() + this.capabilities.parseTimeoutMs;
      const declarations: Declaration[] = []; const errors: Node[] = []; const stack: { node: Node; scope: SymbolObservation['scope'] }[] = [{ node: tree.rootNode, scope: [] }]; let visited = 0;
      while (stack.length && visited++ < this.capabilities.maxNodes) {
        if (visited % 1024 === 0 && performance.now() > deadline) break;
        const { node, scope } = stack.pop()!; if (node.isError || node.isMissing) errors.push(node);
        const declarationKind = snapshot.language === 'java' ? null : kind(node); let nestedScope = scope;
        if (snapshot.language === 'java') {
          const extracted = javaDeclaration(node, scope); declarations.push(...extracted);
          // Annotations and record components do not enclose sibling members.
          const enclosing = extracted.find(item => !['annotation', 'record-component', 'package', 'import', 'field'].includes(item.kind));
          if (enclosing) nestedScope = [...scope, { kind: enclosing.kind, name: enclosing.name }];
        } else if (declarationKind) {
          const nameNode = node.childForFieldName(declarationKind === 'import' ? 'source' : 'name'); const name = nameNode && ['identifier', 'type_identifier', 'property_identifier', 'private_property_identifier', 'string'].includes(nameNode.type) ? nameNode.text : null;
          declarations.push({ node, kind: declarationKind, name, scope }); nestedScope = [...scope, { kind: declarationKind, name }];
        }
        for (const child of [...node.children].reverse()) stack.push({ node: child, scope: nestedScope });
      }
      if (stack.length) { diagnostic(visited >= this.capabilities.maxNodes ? 'SYMBOL_NODE_LIMIT' : 'SYMBOL_ANALYSIS_TIMEOUT', snapshot.side, null, 'Syntax traversal exceeded its bound; this source side was withheld'); continue; }
      for (const declaration of declarations) { const key = JSON.stringify([snapshot.side, matchingKey({ language: snapshot.language, kind: declaration.kind, name: declaration.name, scope: declaration.scope })]); declarationCounts.set(key, (declarationCounts.get(key) ?? 0) + 1); }
      if (tree.rootNode.hasError) diagnostic('SYMBOL_SYNTAX_ERROR', snapshot.side, errors[0] ? range(errors[0]) : range(tree.rootNode), 'Syntax errors or missing tokens; affected declarations are withheld');
      const selected = new Map<Declaration, Set<number>>();
      const top: Declaration = { node: tree.rootNode, kind: 'top-level', name: null, scope: [] };
      for (const [index, line] of changed.entries()) {
        if (performance.now() > deadline) { result.unmappedChangedLines += changed.length - index; diagnostic('SYMBOL_ANALYSIS_TIMEOUT', snapshot.side, null, 'Remaining changed lines were not mapped at the analysis time bound'); break; }
        const start = lineStarts[line.number - 1]; if (start === undefined) { result.unmappedChangedLines++; continue; } const end = lineStarts[line.number] ?? text.length;
        const overlaps = (node: Node) => node.startIndex < end && node.endIndex > start || node.startIndex === node.endIndex && node.startIndex >= start && node.startIndex <= end;
        if (errors.some(overlaps)) { result.unmappedChangedLines++; continue; }
        const candidates = declarations.filter(declaration => overlaps(declaration.node) && !declaration.node.hasError);
        const inner = candidates.filter(declaration => !candidates.some(other => other !== declaration && other.node.startIndex >= declaration.node.startIndex && other.node.endIndex <= declaration.node.endIndex && (other.node.startIndex > declaration.node.startIndex || other.node.endIndex < declaration.node.endIndex)));
        // A Java header can share a line with annotations, components or a
        // nested member. Keep each intersecting header as well as the innermost
        // containing declaration; body-only edits do not imply a type change.
        const mapped = snapshot.language === 'java' ? candidates.filter(declaration => inner.includes(declaration) || ['anonymous-class', 'lambda', 'initializer'].includes(declaration.kind) || ['class', 'interface', 'record', 'enum', 'annotation-type', 'method', 'constructor'].includes(declaration.kind) && declaration.node.startIndex < end && (declaration.node.childForFieldName('body')?.startIndex ?? declaration.node.endIndex) > start) : inner;
        for (const declaration of mapped.length ? mapped : [top]) { const hunks = selected.get(declaration) ?? new Set<number>(); hunks.add(line.hunk); selected.set(declaration, hunks); }
      }
      for (const [declaration, hunks] of [...selected].sort(([a], [b]) => a.node.startIndex - b.node.startIndex || a.node.endIndex - b.node.endIndex)) {
        if (result.symbols.length >= maxSymbols || performance.now() > deadline) { result.omittedSymbols++; continue; }
        const location = declaration.kind === 'top-level' ? { startByte: 0, endByte: bytes.length, startLine: 1, endLine: sourceLines.length, startColumn: 0, endColumn: Buffer.byteLength(sourceLines.at(-1)!) } : range(declaration.node);
        result.symbols.push({ ordinal: result.symbols.length + 1, side: snapshot.side, language: snapshot.language, kind: declaration.kind, name: declaration.name, scope: declaration.scope, range: location, contentHash: hash(bytes.subarray(location.startByte, location.endByte)), hunkOrdinals: [...hunks].sort((a, b) => a - b), matching: declaration.name === null || ['import', 'package', 'annotation', 'top-level'].includes(declaration.kind) ? 'not-applicable' : 'unmatched', counterpartOrdinal: null, ...(declaration.signatureDisplay !== undefined ? { signatureDisplay: declaration.signatureDisplay } : {}) });
      }
    }
    const groups = new Map<string, SymbolObservation[]>();
    for (const symbol of result.symbols) { const key = matchingKey(symbol); const group = groups.get(key) ?? []; group.push(symbol); groups.set(key, group); }
    for (const symbol of result.symbols.filter(item => item.matching !== 'not-applicable')) {
      const key = matchingKey(symbol); const other = groups.get(key)!.filter(item => item.side !== symbol.side);
      if ((declarationCounts.get(JSON.stringify([symbol.side, key])) ?? 0) > 1 || (declarationCounts.get(JSON.stringify([symbol.side === 'before' ? 'after' : 'before', key])) ?? 0) > 1) symbol.matching = 'ambiguous';
      else if (other.length === 1 && (symbol.language !== 'java' || symbol.signatureDisplay === other[0]!.signatureDisplay)) { symbol.matching = 'candidate'; symbol.counterpartOrdinal = other[0]!.ordinal; }
    }
    if (result.symbols.some(symbol => symbol.matching === 'ambiguous')) diagnostic('SYMBOL_MATCH_AMBIGUOUS', null, null, 'Repeated kind/name/scope cannot establish a unique syntactic pairing; occurrences remain separate');
    if (result.unmappedChangedLines && !result.reasons.includes('SYMBOL_SYNTAX_ERROR') && !result.reasons.includes('SYMBOL_ANALYSIS_TIMEOUT')) diagnostic('SYMBOL_MAPPING_INCOMPLETE', null, null, 'Some changed lines could not be mapped to the parsed source');
    if (result.omittedSymbols) diagnostic('SYMBOL_OUTPUT_LIMIT', null, null, 'Whole symbol observations omitted at their bound');
    result.reasons = [...new Set(result.reasons)].sort(); result.state = result.reasons.length ? result.symbols.length ? 'partial' : 'unavailable' : 'complete'; return result;
  }
}
