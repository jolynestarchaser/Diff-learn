export type DiscoveryRequest = { references: boolean; relatedTests: boolean; history: boolean; maxSymbols: number; maxResults: number; maxHistory: number };
export const discoveryDefaults = { maxSymbols: 32, maxResults: 50, maxHistory: 20 };
export type CandidateDiagnostic = { code: string; repositoryId: string | null; path: string | null; message: string };
export type ContentSnapshot = { repositoryId: string; snapshotId: string; comparisonId: string; corpusId: string; path: string; pathBytes: string; origin: 'git-blob' | 'filesystem'; endpoint: 'commit' | 'index' | 'working-tree'; oid: string | null; sha256: string; byteLength: number };
export type CorpusFile = { snapshot: ContentSnapshot; bytes: Buffer };
export type Corpus = { files: CorpusFile[]; reasons: string[]; diagnostics: CandidateDiagnostic[]; excludedFiles: number; omittedFiles: number; snapshotIds: string[] };
export type QueryResult = { outcome: 'matches' | 'no-matches' | 'missing-rg' | 'execution-error' | 'truncated'; matches: { file: CorpusFile; startByte: number; endByte: number; line: number; startColumn: number; endColumn: number }[]; reasons: string[]; observedMatches: number; omittedMatches: number | null; arguments: string[] };
