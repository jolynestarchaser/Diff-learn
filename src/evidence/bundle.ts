import { ScanError } from '../config/load.js';
import type { RepositoryStatus } from '../git/collector.js';
import type { Scope } from '../git/adapter.js';
import { patchOptions, diffOptions } from '../git/adapter.js';
import { compareText } from '../git/identity.js';
import { bundleSchema, evidenceId, validateEntry, validateBundle, unsupportedAnalysis, type Evidence, type EvidenceBundle, type Source, type Subject } from './schema.js';

type DiagnosticInput = { code: string; severity: 'warning' | 'error'; stage: 'discovery' | 'collection' | 'export'; path: string | null; message: string; repositoryId?: string; scope?: Scope | null };
export type BundleInput = { collector: unknown; collection: unknown; request: unknown; discovery: unknown; repositories: RepositoryStatus[]; diagnostics: DiagnosticInput[]; discoveryCompleteness: { state: string; reasons: string[]; omittedCount: number | null } };
const unique = (items: string[]) => [...new Set(items)].sort(compareText);
const pathOrder = (a: { pathBytes: string }, b: { pathBytes: string }) => Buffer.compare(Buffer.from(a.pathBytes, 'base64'), Buffer.from(b.pathBytes, 'base64'));
const blankSubject: Subject = { pathBytes: null, originalPathBytes: null, ordinal: null };
const scopeOrder: Scope[] = ['branch', 'staged', 'unstaged', 'all'];
function normalized(repository: RepositoryStatus): RepositoryStatus {
  const repo = structuredClone(repository);
  repo.reasons = unique(repo.reasons); repo.submodules.sort((a, b) => compareText(a.path, b.path));
  repo.untracked.sort(pathOrder); repo.conflicts.sort(pathOrder);
  if (repo.workingTree) { repo.workingTree.entries.sort(pathOrder); repo.workingTree.untracked.sort(pathOrder); repo.workingTree.reasons = unique(repo.workingTree.reasons); }
  if (repo.capabilities) { repo.capabilities.intentToAddPaths.sort(pathOrder); repo.capabilities.activeFilterPaths.sort(compareText); repo.capabilities.restrictedPaths.sort((a, b) => compareText(a.path ?? '', b.path ?? '') || compareText(a.reason, b.reason)); }
  repo.comparisons.sort((a, b) => scopeOrder.indexOf(a.scope) - scopeOrder.indexOf(b.scope));
  for (const comparison of repo.comparisons) {
    comparison.reasons = unique(comparison.reasons);
    comparison.files.sort((a, b) => Buffer.compare(Buffer.from(a.destinationPathBytes, 'base64'), Buffer.from(b.destinationPathBytes, 'base64')) || Buffer.compare(Buffer.from(a.originalPathBytes, 'base64'), Buffer.from(b.originalPathBytes, 'base64')));
    for (const file of comparison.files) if (file.patch) file.patch.reasons = unique(file.patch.reasons);
  }
  return repo;
}
function patchArguments(repo: RepositoryStatus, comparison: RepositoryStatus['comparisons'][number], patch: boolean): string[] {
  const head = comparison.scope === 'branch' ? comparison.after.oid : repo.revisions!.head.oid;
  const endpoints = comparison.scope === 'branch' ? [comparison.before.oid!, comparison.after.oid!] : comparison.scope === 'staged' ? ['--cached', ...head ? [head] : []] : comparison.scope === 'all' ? [comparison.before.oid!] : [];
  return [...(comparison.scope === 'branch' || comparison.scope === 'staged') && head ? [`--attr-source=${head}`] : [], 'diff', ...patch ? patchOptions : diffOptions, ...comparison.reasons.includes('RENAME_LIMIT') ? ['--no-renames'] : [], ...patch ? [] : ['--raw', '-z'], ...endpoints, '--'];
}
function repositoryFacts(repo: RepositoryStatus) {
  const evidence: Evidence[] = [];
  const { repositoryId, snapshot, revisions } = repo;
  const summary: EvidenceBundle['repositories'][number] = {
    repositoryId, key: repo.key, path: repo.path, kind: repo.kind, topLevel: repo.topLevel, gitDirectory: repo.gitDirectory, commonDirectory: repo.commonDirectory, linkedWorktree: repo.linkedWorktree, objectFormat: repo.objectFormat as 'sha1' | 'sha256' | null, baseConfiguration: repo.baseConfiguration, submodules: repo.submodules,
    state: repo.state, reasons: repo.reasons, snapshot, revisions, workingTree: repo.workingTree, fingerprints: repo.fingerprints, capabilities: repo.capabilities, repositoryEvidenceId: null, comparisons: [], untrackedEvidenceIds: [], conflictEvidenceIds: [], excludedUntrackedCount: repo.excludedUntrackedCount,
  };
  if (snapshot.consistency !== 'verified-optimistic' || !snapshot.snapshotId || !revisions) return { summary, evidence };
  const inputOids = unique([revisions.head.oid, revisions.base.oid, revisions.mergeBase.oid, ...repo.comparisons.flatMap(comparison => [comparison.before.oid, comparison.after.oid])].filter((oid): oid is string => oid !== null));
  const gitSource = (method: Extract<Source, { kind: 'git' }>['method'], commands: string[][], origins: string[], executed = true): Source => ({ kind: 'git', method, executed, arguments: commands, inputOids, originatingEvidenceIds: origins });
  const add = (kind: Evidence['kind'], data: unknown, comparisonId: string | null, subject: Subject, source: Source): string => {
    const entry = { repositoryId, snapshotId: snapshot.snapshotId!, comparisonId, kind, subject, data, source, confidence: 'fact' };
    const checked = validateEntry({ ...entry, id: evidenceId(entry as Parameters<typeof evidenceId>[0]) }); evidence.push(checked); return checked.id;
  };
  const repositoryEvidenceId = add('repository', { key: repo.key, path: repo.path, objectFormat: repo.objectFormat, linkedWorktree: repo.linkedWorktree, submodules: repo.submodules, revisions, workingTree: repo.workingTree, fingerprints: repo.fingerprints, capabilities: repo.capabilities }, null, blankSubject, gitSource('snapshot-metadata', [['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], ['ls-files', '--stage', '-z'], ...repo.workingTree?.available ? [['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=none']] : []], []));
  summary.repositoryEvidenceId = repositoryEvidenceId;
  for (const comparison of repo.comparisons) {
    const data = { scope: comparison.scope, state: comparison.state, before: comparison.before, after: comparison.after, base: revisions.base, reasons: comparison.reasons, omittedCount: comparison.omittedCount, fileCount: comparison.files.length, patchCoverage: comparison.patchCoverage ?? null };
    const rawArguments = comparison.state === 'unavailable' ? [] : patchArguments(repo, comparison, false);
    const commands = comparison.state === 'unavailable' ? [] : [rawArguments, rawArguments.map(arg => arg === '--raw' ? '--numstat' : arg)];
    const comparisonEvidenceId = add('comparison', data, comparison.comparisonId, blankSubject, gitSource(comparison.state === 'unavailable' ? 'comparison-plan' : 'diff-raw-numstat', commands, [repositoryEvidenceId], comparison.state !== 'unavailable'));
    const fileEvidenceIds: string[] = [];
    summary.comparisons.push({ ...data, comparisonId: comparison.comparisonId, evidenceId: comparisonEvidenceId, fileEvidenceIds });
    for (const file of comparison.files) {
      const { patch, languageAnalysis: _analysis, ...metadata } = file;
      const patchSummary = patch ? { state: patch.state, representation: patch.representation, observedHunks: patch.observedHunks, collectedHunks: patch.hunks.length, omittedHunks: patch.omittedHunks, reasons: patch.reasons } : { state: 'unavailable', representation: 'unsupported', observedHunks: 0, collectedHunks: 0, omittedHunks: null, reasons: ['PATCH_NOT_COLLECTED'] };
      const subject: Subject = { pathBytes: file.destinationPathBytes, originalPathBytes: file.originalPathBytes, ordinal: null };
      const fileEvidenceId = add('file-change', { ...metadata, comparisonEvidenceId, patch: patchSummary }, comparison.comparisonId, subject, gitSource('diff-raw-numstat', commands, [comparisonEvidenceId]));
      fileEvidenceIds.push(fileEvidenceId);
      for (const hunk of patch?.hunks ?? []) {
        const { hunkId: _legacyId, ...data } = hunk;
        add('hunk', { ...data, fileEvidenceId }, comparison.comparisonId, { ...subject, ordinal: hunk.ordinal }, { kind: 'diff-parser', method: 'unified-two-sided', arguments: patchArguments(repo, comparison, true), inputOids, originatingEvidenceIds: [fileEvidenceId, comparisonEvidenceId] });
      }
    }
  }
  for (const file of repo.untracked) summary.untrackedEvidenceIds.push(add('untracked-file', { ...file, content: file.content ?? null }, null, { ...blankSubject, pathBytes: file.pathBytes }, { kind: 'filesystem', method: file.type === 'unsafe-parent' || file.type === 'unsupported-path-encoding' ? 'not-read' : file.content?.sha256 ? 'bounded-read-and-hash' : 'lstat', pathBytes: file.pathBytes, sha256: file.content?.sha256 ?? null, interval: { startedAt: snapshot.startedAt, endedAt: snapshot.endedAt }, originatingEvidenceIds: [repositoryEvidenceId] }));
  for (const conflict of repo.conflicts) summary.conflictEvidenceIds.push(add('conflict', conflict, null, { ...blankSubject, pathBytes: conflict.pathBytes }, gitSource('conflict-index', [['ls-files', '--stage', '-z']], [repositoryEvidenceId])));
  return { summary, evidence };
}
function withoutContent(repository: RepositoryStatus): RepositoryStatus {
  const repo = structuredClone(repository); let omitted = 0;
  for (const comparison of repo.comparisons) {
    let changed = false;
    for (const file of comparison.files) if (file.patch?.hunks.length) {
      const count = file.patch.hunks.length; omitted += count; changed = true; file.patch.hunks = []; file.patch.state = 'partial'; file.patch.reasons = unique([...file.patch.reasons, 'EVIDENCE_OUTPUT_LIMIT']);
      if (file.patch.omittedHunks !== null) file.patch.omittedHunks += count;
      if (comparison.patchCoverage?.omittedHunks !== null && comparison.patchCoverage) comparison.patchCoverage.omittedHunks += count;
    }
    if (changed) { comparison.state = 'partial'; comparison.reasons = unique([...comparison.reasons, 'EVIDENCE_OUTPUT_LIMIT']); }
  }
  for (const file of repo.untracked) if (file.content?.state === 'collected') { omitted++; file.content = { ...file.content, contentId: null, state: 'omitted', reason: 'EVIDENCE_OUTPUT_LIMIT', text: null, bytes: null }; }
  if (omitted) { repo.state = 'partial'; repo.reasons = unique([...repo.reasons, 'EVIDENCE_OUTPUT_LIMIT']); }
  return repo;
}
function omittedRepository(repo: RepositoryStatus): RepositoryStatus {
  return { ...repo, state: 'failed', reasons: ['EVIDENCE_OUTPUT_LIMIT'], revisions: null, workingTree: null, fingerprints: null, capabilities: null, comparisons: [], untracked: [], conflicts: [], excludedUntrackedCount: null, snapshot: { ...repo.snapshot, snapshotId: null, consistency: 'unverified' } };
}
export function buildBundle(input: BundleInput): EvidenceBundle {
  const parsed = bundleSchema.pick({ collector: true, collection: true, request: true, discovery: true }).safeParse({ collector: input.collector, collection: input.collection, request: input.request, discovery: input.discovery });
  if (!parsed.success) throw new ScanError('INTERNAL_CONTRACT_ERROR', 'Invalid collection envelope', 1);
  const envelope = parsed.data; envelope.request.repositories.sort(compareText);
  const repositories: EvidenceBundle['repositories'] = []; const evidence: Evidence[] = [];
  const diagnostics: EvidenceBundle['diagnostics'] = input.diagnostics.map(item => ({ ...item, repositoryId: item.repositoryId ?? null, scope: item.scope ?? null }));
  let bytes = 0; let exhausted = false;
  const quota = envelope.request.limits.maxBundleBytes / 2;
  for (const original of [...input.repositories].sort((a, b) => compareText(a.key, b.key))) {
    const repo = normalized(original); let facts = repositoryFacts(exhausted ? omittedRepository(repo) : repo);
    let cost = Buffer.byteLength(JSON.stringify(facts));
    if (exhausted || cost + bytes > quota) {
      facts = repositoryFacts(withoutContent(repo)); cost = Buffer.byteLength(JSON.stringify(facts));
      if (exhausted || cost + bytes > quota) { facts = repositoryFacts(omittedRepository(repo)); cost = Buffer.byteLength(JSON.stringify(facts)); exhausted = true; }
      diagnostics.push({ code: 'EVIDENCE_OUTPUT_LIMIT', severity: 'warning', stage: 'export', repositoryId: repo.repositoryId, path: repo.path, scope: null, message: exhausted ? 'Repository evidence omitted at the deterministic output budget; inventory retained' : 'Whole hunks and filesystem content omitted at the deterministic output budget; metadata retained' });
    }
    bytes += cost; repositories.push(facts.summary); evidence.push(...facts.evidence);
  }
  const keys = new Map(repositories.map(repo => [repo.repositoryId, repo.key]));
  diagnostics.sort((a, b) => compareText(keys.get(a.repositoryId ?? '') ?? '', keys.get(b.repositoryId ?? '') ?? '') || compareText(a.stage, b.stage) || compareText(a.code, b.code) || compareText(a.path ?? '', b.path ?? '') || compareText(a.message, b.message));
  const reasons = unique([...input.discoveryCompleteness.reasons, ...repositories.flatMap(repo => repo.reasons)]);
  const complete = input.discoveryCompleteness.state === 'complete' && repositories.every(repo => repo.state === 'complete');
  const state = complete ? 'complete' : repositories.some(repo => repo.repositoryEvidenceId !== null) || repositories.length === 0 && envelope.discovery.readableDirectories > 0 ? 'partial' : 'failed';
  const bundle = validateBundle({ ...envelope, schemaVersion: '1.0.0', reportKind: 'evidence', repositories, evidence, diagnostics, completeness: { state, reasons, repositoryStates: repositories.map(repo => ({ repositoryId: repo.repositoryId, state: repo.state })), requestedRepositories: repositories.length, collectedRepositories: repositories.filter(repo => repo.repositoryEvidenceId !== null).length, collectedEvidence: evidence.length, omittedCount: complete ? 0 : null }, analysis: { policy: 'git-facts-only', unsupported: [...unsupportedAnalysis] }, trust: { repositoryContent: 'untrusted-agent-input', export: 'explicit-command-stdout-only' } });
  if (Buffer.byteLength(JSON.stringify(bundle)) > envelope.request.limits.maxBundleBytes) throw new ScanError('BUNDLE_LIMIT', 'Minimal evidence envelope exceeds maxBundleBytes; narrow the workspace or increase the budget', 1);
  return bundle;
}
