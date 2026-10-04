import path from 'node:path';
import type Parser from 'tree-sitter';
import { languageForPath } from '../language/contracts.js';
import type { CorpusFile } from './contracts.js';

export type StructuralHint = { kind: 'import' | 'test-call'; text: string; startByte: number; endByte: number; line: number };
export type TestStructure = { filename: boolean; hints: StructuralHint[]; reason: string | null };
export function testFilename(filename: string) { return /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/u.test(filename); }
export const fileStem = (filename: string) => path.posix.basename(filename).replace(/\.(?:[cm]?[jt]sx?)$/u, '').replace(/\.(?:test|spec)$/u, '');
export async function inspectTest(file: CorpusFile): Promise<TestStructure> {
  const result: TestStructure = { filename: testFilename(file.snapshot.path), hints: [], reason: null }; const language = languageForPath(file.snapshot.path); if (!language) return result;
  let tree: Parser.Tree | undefined;
  try {
    const { createLanguageParser } = await import('../language/tree-sitter.js'); const parser = createLanguageParser(language); const text = file.bytes.toString('utf8'); tree = parser.parse(text);
    if (!tree || tree.rootNode.hasError) { result.reason = 'TEST_STRUCTURE_UNAVAILABLE'; return result; }
    const nodes = [tree.rootNode]; let visited = 0; const deadline = performance.now() + 250;
    while (nodes.length) {
      if (++visited > 100000 || performance.now() > deadline) { result.reason = 'TEST_STRUCTURE_LIMIT'; result.hints = []; break; }
      const node = nodes.pop()!; let value: string | null = null; let kind: StructuralHint['kind'] = 'import';
      if (node.type === 'import_statement') { const source = node.childForFieldName('source'); if (source && /^(?:"[^"\\]*"|'[^'\\]*')$/u.test(source.text)) value = source.text.slice(1, -1); }
      if (node.type === 'call_expression') { const callee = node.childForFieldName('function'); if (callee && /^(?:test|it|describe|suite)(?:\.(?:only|skip))?$/u.test(callee.text)) { value = callee.text; kind = 'test-call'; } }
      if (value !== null) result.hints.push({ kind, text: value, startByte: Buffer.byteLength(text.slice(0, node.startIndex)), endByte: Buffer.byteLength(text.slice(0, node.endIndex)), line: node.startPosition.row + 1 });
      const children = node.namedChildren; for (let index = children.length - 1; index >= 0; index--) nodes.push(children[index]!);
    }
  } catch { result.reason = 'TEST_STRUCTURE_UNAVAILABLE'; }
  return result;
}
export function importMatches(importer: string, specifier: string, source: string) {
  if (!specifier.startsWith('.')) return false;
  const removeExtension = (name: string) => name.replace(/\.[cm]?[jt]sx?$/u, '');
  const target = removeExtension(path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier)));
  return target === removeExtension(source) || `${target}/index` === removeExtension(source);
}
