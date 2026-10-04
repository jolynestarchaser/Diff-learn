import type { Config, Limits } from '../config/schema.js';
import { ScanError } from '../config/load.js';
import type { RepositoryStatus } from '../git/collector.js';
import type { SnapshotBudget } from '../git/snapshot.js';
import { runGit, type GitRunner } from '../git/runner.js';
import type { SyntaxBundle } from '../evidence/syntax.js';
import { candidateId, candidateProjection, validateCandidateBundle, type CandidateBundle, type CandidateEvidence } from '../evidence/candidates.js';
import { collectCorpus } from './corpus.js';
import { CandidateSearch, runRg, type RgRunner } from './rg.js';
import { collectHistory } from './history.js';
import { inspectTest, importMatches, fileStem, type TestStructure } from './tests.js';
import type { DiscoveryRequest, QueryResult } from './contracts.js';

export async function extendCandidateBundle(base: SyntaxBundle, repositories: RepositoryStatus[], config: Config, limits: Limits, budget: SnapshotBudget, request: DiscoveryRequest, cliBase?: string, signal?: AbortSignal, gitRunner: GitRunner = runGit, rgRunner: RgRunner = runRg): Promise<CandidateBundle> {
  const deadline = performance.now() + Math.min(limits.repoTimeoutMs, 120000), maxQueryBytes = Math.min(limits.maxMetadataBytes, 4 * 1024 * 1024), queryTimeoutMs = Math.min(limits.gitTimeoutMs, 10000);
  const evidence: CandidateEvidence[] = [...base.evidence]; const diagnostics = [...base.diagnostics];
  type Component = CandidateBundle['discoveryAnalysis']['references'];
  const component = (requested: boolean): Component => ({ requested, state: requested ? 'complete' : 'not-requested', reasons: [], queriesRequested: 0, queriesCollected: 0, omittedQueries: 0, evidenceIds: [] });
  const references = component(request.references), relatedTests = component(request.relatedTests), history = component(request.history);
  const warn = (code: string, message: string, repositoryId: string | null = null, path: string | null = null) => diagnostics.push({ code, message, repositoryId, path, scope: base.request.scopes[0]!, stage: 'collection', severity: 'warning' });
  const expired = () => { if (signal?.aborted) throw new ScanError('INTERRUPTED', 'Candidate discovery interrupted', 1); return performance.now() >= deadline; };
  const corpus = request.references || request.relatedTests ? await collectCorpus(repositories, config, limits, budget, cliBase, signal, gitRunner, deadline) : { files: [], reasons: [], diagnostics: [], excludedFiles: 0, omittedFiles: 0, snapshotIds: [] };
  for (const diagnostic of corpus.diagnostics) warn(diagnostic.code, diagnostic.message, diagnostic.repositoryId, diagnostic.path);
  for (const state of [references, relatedTests]) if (state.requested) { state.reasons.push(...corpus.reasons); if (base.languageAnalysis.state !== 'complete') state.reasons.push('CANDIDATE_SYMBOL_INPUT_INCOMPLETE'); }
  const symbols = base.evidence.filter(entry => entry.kind === 'symbol' && entry.data.kind !== 'import' && entry.data.kind !== 'top-level' && entry.data.name !== null && /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(entry.data.name));
  const fileById = new Map(base.evidence.filter(entry => entry.kind === 'file-change').map(file => [file.id, file]));
  for (const state of [references, relatedTests]) if (state.requested) { state.queriesRequested = symbols.length; if (symbols.length > request.maxSymbols) state.reasons.push('CANDIDATE_SYMBOL_LIMIT'); }
  const structures = new Map<string, TestStructure>();
  if (request.relatedTests) for (const file of corpus.files) {
    if (expired()) { relatedTests.reasons.push('DISCOVERY_TIMEOUT'); break; }
    const structure = await inspectTest(file); structures.set(`${file.snapshot.repositoryId}:${file.snapshot.pathBytes}`, structure);
    if (structure.reason) { relatedTests.reasons.push(structure.reason); warn(structure.reason, 'Structural test hints unavailable; filename and text heuristics remain candidates', file.snapshot.repositoryId, file.snapshot.path); }
  }
  let search: CandidateSearch | undefined;
  try {
    if ((request.references || request.relatedTests) && symbols.length && !expired()) search = await CandidateSearch.create(corpus.files, maxQueryBytes, queryTimeoutMs, signal, rgRunner);
    const cache = new Map<string, QueryResult>();
    for (const symbol of symbols.slice(0, request.maxSymbols)) {
      if (expired()) { for (const state of [references, relatedTests]) if (state.requested) state.reasons.push('DISCOVERY_TIMEOUT'); break; }
      if (symbol.kind !== 'symbol' || !symbol.data.name || !search) continue;
      const query = symbol.data.name; let result = cache.get(query);
      if (!result) { result = await search.search(query, request.maxResults, deadline - performance.now()); cache.set(query, result); }
      const anchor = { repositoryId: symbol.repositoryId, snapshotId: symbol.snapshotId, comparisonId: symbol.comparisonId, subject: { ...symbol.subject } };
      const provenance = { kind: 'candidate-discovery' as const, method: 'rg-fixed-string' as const, executed: corpus.files.length > 0 && result.outcome !== 'missing-rg', arguments: [result.arguments], originatingEvidenceIds: [symbol.id] };
      if (request.references) {
        const entry = { ...anchor, kind: 'reference-query' as const, confidence: 'fact' as const, source: provenance, data: { symbolEvidenceId: symbol.id, query, searchRule: 'case-sensitive-fixed-substring' as const, corpusIds: corpus.snapshotIds, outcome: result.outcome, reasons: [...new Set([...result.reasons, ...corpus.reasons])].sort(), observedMatches: result.observedMatches, retainedMatches: result.matches.length, omittedMatches: result.omittedMatches, sameNameSymbolIds: symbols.filter(other => other.kind === 'symbol' && other.data.name === query).map(other => other.id) } };
        const queryId = candidateId(entry); evidence.push({ ...entry, id: queryId }); references.queriesCollected++; references.reasons.push(...result.reasons);
        for (const match of result.matches) {
          const candidate = { ...anchor, kind: 'reference-candidate' as const, confidence: 'candidate' as const, source: { ...provenance, originatingEvidenceIds: [symbol.id, queryId] }, data: { symbolEvidenceId: symbol.id, queryEvidenceId: queryId, query, location: { content: match.file.snapshot, startByte: match.startByte, endByte: match.endByte, line: match.line, startColumn: match.startColumn, endColumn: match.endColumn }, crossRepository: match.file.snapshot.repositoryId !== symbol.repositoryId, interpretation: 'text-match-not-confirmed-reference' as const } };
          evidence.push({ ...candidate, id: candidateId(candidate) });
        }
      }
      if (request.relatedTests) {
        relatedTests.reasons.push(...result.reasons); const candidates: Extract<CandidateEvidence, { kind: 'related-test-candidate' }>['data'][] = []; let omissions = 0;
        const sourceFile = fileById.get(symbol.data.fileEvidenceId)!; const sourcePaths = [sourceFile.data.originalPath, sourceFile.data.destinationPath].filter((path): path is string => path !== null);
        for (const file of corpus.files) {
          if (expired()) { relatedTests.reasons.push('DISCOVERY_TIMEOUT'); break; }
          const structure = structures.get(`${file.snapshot.repositoryId}:${file.snapshot.pathBytes}`); if (!structure) continue;
          const testCall = structure.hints.some(hint => hint.kind === 'test-call'); if (!structure.filename && !testCall) continue;
          const textMatch = result.matches.find(match => match.file === file); const sameRepo = file.snapshot.repositoryId === symbol.repositoryId;
          const imports = sameRepo ? structure.hints.filter(hint => hint.kind === 'import' && sourcePaths.some(source => importMatches(file.snapshot.path, hint.text, source))) : [];
          const sameStem = sameRepo && sourcePaths.some(source => fileStem(source) === fileStem(file.snapshot.path)); const nameInFilename = fileStem(file.snapshot.path) === query;
          if (!textMatch && !imports.length && !sameStem && !nameInFilename) continue;
          const heuristic: Extract<CandidateEvidence, { kind: 'related-test-candidate' }>['data']['heuristic'] = [...structure.filename ? ['test-filename' as const] : [], ...testCall ? ['test-call-syntax' as const] : [], ...sameStem ? ['same-file-stem' as const] : [], ...nameInFilename ? ['symbol-name-in-filename' as const] : [], ...textMatch ? ['fixed-string-symbol-text' as const] : [], ...imports.length ? ['relative-import-syntax' as const] : []];
          const hint = imports[0] ?? structure.hints.find(hint => hint.kind === 'test-call');
          if (candidates.length >= request.maxResults) { omissions++; continue; }
          candidates.push({ symbolEvidenceId: symbol.id, queryEvidenceId: '', query, content: file.snapshot, range: textMatch ? { startByte: textMatch.startByte, endByte: textMatch.endByte, line: textMatch.line } : hint ? { startByte: hint.startByte, endByte: hint.endByte, line: hint.line } : null, heuristic, importHints: imports, crossRepository: !sameRepo, testExecution: 'not-run', interpretation: 'potential-test-no-coverage-conclusion' });
        }
        if (omissions) relatedTests.reasons.push('RELATED_TEST_RESULT_LIMIT');
        const reasons = [...new Set([...result.reasons, ...corpus.reasons, ...[...structures.values()].flatMap(structure => structure.reason ? [structure.reason] : []), ...omissions ? ['RELATED_TEST_RESULT_LIMIT'] : [], ...relatedTests.reasons.includes('DISCOVERY_TIMEOUT') ? ['DISCOVERY_TIMEOUT'] : []])].sort();
        const entry = { ...anchor, kind: 'related-test-query' as const, confidence: 'fact' as const, source: { ...provenance, method: 'test-heuristic' as const }, data: { symbolEvidenceId: symbol.id, query, outcome: reasons.length ? candidates.length ? 'partial' as const : 'unavailable' as const : candidates.length ? 'candidates' as const : 'no-candidates' as const, reasons, retainedCandidates: candidates.length, omittedCandidates: result.outcome === 'truncated' || reasons.includes('DISCOVERY_TIMEOUT') ? null : omissions, testExecution: 'not-run' as const } };
        const queryId = candidateId(entry); evidence.push({ ...entry, id: queryId }); relatedTests.queriesCollected++;
        for (const data of candidates) { data.queryEvidenceId = queryId; const candidate = { ...anchor, kind: 'related-test-candidate' as const, confidence: 'candidate' as const, source: { ...entry.source, originatingEvidenceIds: [symbol.id, queryId] }, data }; evidence.push({ ...candidate, id: candidateId(candidate) }); }
      }
      for (const reason of result.reasons) warn(reason, `Fixed-string query ${JSON.stringify(query)}: ${result.outcome}; candidates do not establish callers or dependencies`, symbol.repositoryId);
    }
  } catch (error) { if (signal?.aborted) throw error; for (const state of [references, relatedTests]) if (state.requested) state.reasons.push('CANDIDATE_SEARCH_FAILED'); warn('CANDIDATE_SEARCH_FAILED', 'Candidate search unavailable; Git and symbol evidence retained'); }
  finally { await search?.dispose(); }
  if (request.history) {
    const files = [...fileById.values()]; history.queriesRequested = files.length;
    if (files.length > request.maxSymbols) history.reasons.push('HISTORY_QUERY_LIMIT');
    for (const file of files.slice(0, request.maxSymbols)) {
      if (expired()) { history.reasons.push('DISCOVERY_TIMEOUT'); break; }
      const repo = repositories.find(repo => repo.repositoryId === file.repositoryId)!; const paths = [file.data.originalPath, file.data.destinationPath].filter((path): path is string => path !== null);
      const result = await collectHistory(repo, paths, request.maxHistory, limits, signal, gitRunner, deadline); history.reasons.push(...result.reasons); history.queriesCollected++;
      const entry = { repositoryId: file.repositoryId, snapshotId: file.snapshotId, comparisonId: file.comparisonId, subject: { ...file.subject }, kind: 'history' as const, confidence: 'fact' as const, data: { ...result, fileEvidenceId: file.id, querySemantics: 'pinned-head-reachable-literal-path-history-no-follow-topological-order' as const, runtimeBehavior: 'not-inferred' as const }, source: { kind: 'candidate-discovery' as const, method: 'git-path-history' as const, executed: result.headOid !== null, arguments: [result.arguments], originatingEvidenceIds: [file.id] } };
      evidence.push({ ...entry, id: candidateId(entry) }); for (const reason of result.reasons) warn(reason, 'Bounded path history is incomplete; commit metadata does not prove runtime behavior', file.repositoryId, file.data.destinationPath);
    }
  }
  if (signal?.aborted) throw new ScanError('INTERRUPTED', 'Candidate discovery interrupted', 1);
  const finish = (state: Component, kinds: string[]) => { state.omittedQueries = state.queriesRequested - state.queriesCollected; state.reasons = [...new Set(state.reasons)].sort(); if (state.requested) state.state = state.reasons.length || state.omittedQueries ? state.queriesCollected ? 'partial' : 'unavailable' : 'complete'; state.evidenceIds = evidence.filter(entry => kinds.includes(entry.kind)).map(entry => entry.id); for (const reason of state.reasons) if (!diagnostics.some(item => item.code === reason)) warn(reason, 'Candidate discovery is incomplete; absence is not evidence of missing tests or dependencies'); };
  finish(references, ['reference-query', 'reference-candidate']); finish(relatedTests, ['related-test-query', 'related-test-candidate']); finish(history, ['history']);
  const build = (): CandidateBundle => {
    const reasons = [...new Set([...base.completeness.reasons, ...references.reasons, ...relatedTests.reasons, ...history.reasons])].sort();
    return { ...candidateProjection(base, request), evidence, diagnostics, discoveryAnalysis: { request, limits: { maxCorpusFiles: Math.min(limits.maxFiles, 500), maxCorpusBytes: limits.maxPatchBytes, maxFileBytes: limits.maxFileBytes, maxQueryBytes, queryTimeoutMs, analysisTimeoutMs: Math.min(limits.repoTimeoutMs, 120000) }, corpus: { state: request.references || request.relatedTests ? corpus.reasons.length ? 'partial' : 'complete' : 'not-requested', reasons: corpus.reasons, snapshotIds: corpus.snapshotIds, files: corpus.files.map(file => file.snapshot), excludedFiles: corpus.excludedFiles, omittedFiles: corpus.omittedFiles }, references, relatedTests, history, syntaxCompleteness: base.completeness }, completeness: { ...base.completeness, state: base.completeness.state === 'failed' ? 'failed' : reasons.length ? 'partial' : base.completeness.state, reasons, collectedEvidence: evidence.length, omittedCount: reasons.length ? null : base.completeness.omittedCount } };
  };
  let bundle = build();
  if (Buffer.byteLength(JSON.stringify(bundle)) > limits.maxBundleBytes) {
    evidence.splice(base.evidence.length); corpus.omittedFiles += corpus.files.length; corpus.files = []; corpus.snapshotIds = []; corpus.reasons.push('DISCOVERY_OUTPUT_LIMIT');
    diagnostics.splice(base.diagnostics.length); warn('DISCOVERY_OUTPUT_LIMIT', 'Whole candidate/history evidence omitted at maxBundleBytes; Git and syntax evidence retained');
    for (const state of [references, relatedTests, history]) if (state.requested) { state.queriesCollected = 0; state.reasons.push('DISCOVERY_OUTPUT_LIMIT'); finish(state, []); }
    bundle = build();
  }
  if (Buffer.byteLength(JSON.stringify(bundle)) > limits.maxBundleBytes) throw new ScanError('BUNDLE_LIMIT', 'Minimal candidate extension exceeds maxBundleBytes', 1);
  return validateCandidateBundle(bundle);
}
