import type { FilePatch } from '../diff/unified.js';

export type Language = 'typescript' | 'tsx' | 'javascript';
export type SourceRange = { startByte: number; endByte: number; startLine: number; endLine: number; startColumn: number; endColumn: number };
export type LanguageDiagnostic = { code: string; side: 'before' | 'after' | null; range: SourceRange | null; message: string };
export type SourceSnapshot = { side: 'before' | 'after'; path: string | null; pathBytes: string; language: Language | null; origin: 'git-blob' | 'filesystem' | 'absent'; oid: string | null; sha256: string | null; byteLength: number | null; state: 'available' | 'unavailable'; reason: string | null };
export type SymbolObservation = { ordinal: number; side: 'before' | 'after'; language: Language; kind: 'class' | 'method' | 'function' | 'arrow-function' | 'variable' | 'interface' | 'type-alias' | 'enum' | 'namespace' | 'import' | 'top-level'; name: string | null; scope: { kind: string; name: string | null }[]; range: SourceRange; contentHash: string; hunkOrdinals: number[]; matching: 'candidate' | 'unmatched' | 'ambiguous' | 'not-applicable'; counterpartOrdinal: number | null };
export type LanguageCapabilities = { analyzer: 'tree-sitter'; runtime: '0.21.1'; grammarAbi: 14; grammars: { language: Language; package: string; version: string }[]; declarations: true; imports: true; topLevel: true; syntacticMatching: true; semanticReferences: false; typeChecking: false; inferredBehavior: false; inferredContracts: false; maxNodes: 100000; parseTimeoutMs: 250 };
export type LanguageResult = { state: 'complete' | 'partial' | 'unavailable'; reasons: string[]; sources: SourceSnapshot[]; symbols: SymbolObservation[]; diagnostics: LanguageDiagnostic[]; unmappedChangedLines: number; omittedSymbols: number; changeInterpretation: 'syntax-only'; references: 'unavailable'; behavior: 'unavailable'; contracts: 'unavailable' };
export interface LanguageAnalyzer {
  readonly capabilities: LanguageCapabilities;
  languageForPath(path: string | null): Language | null;
  analyze(input: { sources: { snapshot: SourceSnapshot; bytes: Buffer | null }[]; patch: FilePatch; maxSymbols: number }): LanguageResult;
}
export const languageForPath = (filename: string | null): Language | null => filename === null ? null : /\.(?:tsx)$/iu.test(filename) ? 'tsx' : /\.(?:ts|mts|cts)$/iu.test(filename) ? 'typescript' : /\.(?:js|jsx|mjs|cjs)$/iu.test(filename) ? 'javascript' : null;
export const languageCapabilities: LanguageCapabilities = { analyzer: 'tree-sitter', runtime: '0.21.1', grammarAbi: 14, grammars: [{ language: 'typescript', package: 'tree-sitter-typescript', version: '0.23.2' }, { language: 'tsx', package: 'tree-sitter-typescript', version: '0.23.2' }, { language: 'javascript', package: 'tree-sitter-javascript', version: '0.23.1' }], declarations: true, imports: true, topLevel: true, syntacticMatching: true, semanticReferences: false, typeChecking: false, inferredBehavior: false, inferredContracts: false, maxNodes: 100000, parseTimeoutMs: 250 };
