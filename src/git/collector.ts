import { ScanError } from '../config/load.js';
import type { Config, Limits } from '../config/schema.js';
import type { Repository } from './discovery.js';
import { GitAdapter, diffOptions, type Scope, type Revisions } from './adapter.js';
import { capture, digest, type SnapshotBudget } from './snapshot.js';
import type { FileChange, GitPath } from './metadata.js';
import { runGit, type GitRunner } from './runner.js';
import { parseUnified, fileKey, type FilePatch } from '../diff/unified.js';
import type { LanguageResult } from '../language/contracts.js';
import { analyzeFile } from '../language/collect.js';

export type CollectionDiagnostic = { code: string; severity: 'warning'; stage: 'discovery' | 'collection'; repositoryId: string; path: string | null; scope: Scope | null; message: string };
type Endpoint = { kind: 'commit' | 'index' | 'working-tree' | 'empty-tree'; oid: string | null };
export type Comparison = { scope: Scope; comparisonId: string | null; state: 'complete' | 'partial' | 'unavailable'; before: Endpoint; after: Endpoint; files: (FileChange & { patch?: FilePatch; languageAnalysis?: LanguageResult })[]; reasons: string[]; omittedCount: number | null; patchCoverage?: { source: 'git'; retainedBytes: number; observedBytesLowerBound: number; totalBytes: number | null; truncated: boolean; observedHunks: number; omittedHunks: number | null } };
export type DiffRequest = { scope: Scope; includeUntracked: boolean; symbols?: boolean; java?: boolean; commits?: { before: string; after: string; emptyBefore?: boolean } };
export type Conflict = GitPath & { xy: string | null; stages: { base: { mode: string; oid: string } | null; ours: { mode: string; oid: string } | null; theirs: { mode: string; oid: string } | null } };
export type RepositoryStatus = Repository & {
  state: 'complete' | 'partial' | 'failed'; reasons: string[]; revisions: Revisions | null;
  workingTree: Awaited<ReturnType<typeof capture>>['status'] | null;
  untracked: Awaited<ReturnType<typeof capture>>['untracked']; excludedUntrackedCount: number | null;
  conflicts: Conflict[]; comparisons: Comparison[];
  fingerprints: { index: string; workingTree: string; configuration: string; attributes: string } | null;
  capabilities: { sparseCheckout: boolean; restrictedPaths: { path: string | null; reason: string }[]; activeFilterPaths: string[]; intentToAddPaths: GitPath[]; intentToAddPolicy: 'experimental-visible-in-index' } | null;
  snapshot: { snapshotId: string | null; consistency: 'verified-optimistic' | 'inconsistent' | 'unverified'; attempts: number; startedAt: string; endedAt: string; bytesHashed: number };
  diagnostics: CollectionDiagnostic[];
};
const scopes: Scope[] = ['branch', 'staged', 'unstaged', 'all'];
function endpoints(scope: Scope, revisions: Revisions): { before: Endpoint; after: Endpoint } {
  return { before: scope === 'branch' || scope === 'all' ? { kind: 'commit', oid: revisions.mergeBase.oid } : scope === 'unstaged' ? { kind: 'index', oid: null } : { kind: revisions.head.oid ? 'commit' : 'empty-tree', oid: revisions.head.oid }, after: scope === 'branch' ? { kind: 'commit', oid: revisions.head.oid } : { kind: scope === 'staged' ? 'index' : 'working-tree', oid: null } };
}
export async function collectRepository(repository: Repository, config: Config, limits: Limits, budget: SnapshotBudget, cliBase?: string, signal?: AbortSignal, runner: GitRunner = runGit, diff?: DiffRequest): Promise<RepositoryStatus> {
  const startedAt = new Date().toISOString(); const adapter = new GitAdapter(repository, limits, performance.now() + limits.repoTimeoutMs, signal, runner);
  const output: RepositoryStatus = { ...repository, state: 'failed', reasons: [], revisions: null, workingTree: null, untracked: [], excludedUntrackedCount: null, conflicts: [], comparisons: [], fingerprints: null, capabilities: null, snapshot: { snapshotId: null, consistency: 'unverified', attempts: 0, startedAt, endedAt: startedAt, bytesHashed: 0 }, diagnostics: [] };
  const diagnostic = (code: string, message: string, scope: Scope | null = null) => {
    output.diagnostics.push({ code, severity: 'warning', stage: 'collection', repositoryId: repository.repositoryId, path: repository.path, scope, message });
  };
  if (repository.kind !== 'worktree') { output.reasons = [repository.kind === 'unsupported-bare' ? 'UNSUPPORTED_BARE' : 'REPOSITORY_INVALID']; output.snapshot.endedAt = new Date().toISOString(); return output; }
  const initialBytes = budget.workspaceBytes;
  for (let attempt = 1; attempt <= 2; attempt++) {
    output.snapshot.attempts = attempt;
    try {
      const attemptBudget = { bytes: 0 };
      const before = await capture(adapter, config, budget, cliBase, attemptBudget, diff ? { includeUntracked: diff.includeUntracked, retainContent: true, retainTracked: diff.symbols === true && (diff.scope === 'unstaged' || diff.scope === 'all') } : undefined);
      if (diff?.commits && diff.scope !== 'branch') throw new ScanError('COMPARISON_INVALID', 'Pinned commit comparisons require branch scope', 1);
      // Capture/validate the real worktree as usual. Only the comparison endpoints
      // change; language sources for branch comparisons come from raw diff blob IDs.
      const revisions: Revisions = diff?.commits ? { ...before.revisions, head: { oid: diff.commits.after, branch: null, state: 'detached' }, base: { input: diff.commits.before, oid: diff.commits.before, resolutionSource: 'cli', reason: null, remoteFreshness: 'not-verified' }, mergeBase: { ...before.revisions.mergeBase, oid: diff.commits.before, candidates: [diff.commits.before], reason: null } } : before.revisions;
      const conflictPaths = new Set(before.index.filter(entry => entry.stage > 0).map(entry => entry.pathBytes));
      const conflicts: Conflict[] = [...conflictPaths].map(encoded => {
        const entries = before.index.filter(entry => entry.pathBytes === encoded); const first = entries[0]!;
        const stage = (number: number) => { const entry = entries.find(item => item.stage === number); return entry ? { mode: entry.mode, oid: entry.oid } : null; };
        return { path: first.path, pathBytes: encoded, xy: before.status.entries.find(entry => entry.pathBytes === encoded)?.xy ?? null, stages: { base: stage(1), ours: stage(2), theirs: stage(3) } };
      });
      const comparisons: Comparison[] = [];
      const diagnostics: { code: string; message: string; scope: Scope }[] = [];
      for (const scope of diff ? [diff.scope] : scopes) {
        const reasons: string[] = [];
        if (scope === 'branch' || scope === 'staged') reasons.push(...before.immutableReasons);
        if (scope === 'staged' && before.revisions.head.oid === null && before.status.reasons.some(reason => reason === 'WORKTREE_SYMLINK_BOUNDARY' || reason === 'ATTRIBUTE_SYMLINK')) reasons.push('UNBORN_ATTRIBUTE_BOUNDARY');
        if ((scope === 'branch' || scope === 'all') && !revisions.mergeBase.oid) reasons.push(revisions.mergeBase.reason ?? 'BASE_UNRESOLVED');
        if ((scope === 'unstaged' || scope === 'all') && !before.status.available) reasons.push(...before.status.reasons);
        const comparison: Comparison = { scope, comparisonId: null, state: 'unavailable', ...endpoints(scope, revisions), files: [], reasons, omittedCount: null };
        if (diff?.commits?.emptyBefore) comparison.before.kind = 'empty-tree';
        if (reasons.length === 0) {
          try {
            const result = await adapter.comparison(scope, revisions, scope === 'branch' ? new Set() : conflictPaths);
            if (result.renameLimited) reasons.push('RENAME_LIMIT');
            if (scope !== 'branch' && conflicts.length) reasons.push('UNMERGED_PATH');
            comparison.files = result.changes; comparison.state = reasons.length ? 'partial' : 'complete'; comparison.omittedCount = scope === 'branch' ? 0 : conflicts.length;
            if (diff) {
              try {
                const patch = await adapter.patch(scope, revisions, result.renameLimited);
                // Conflict records have no ordinary FileChange; retain the Git
                // conflict diagnostic rather than interpreting a combined hunk.
                const parsed = parseUnified(patch.stdout, result.changes, { maxHunks: limits.maxHunks, maxFileBytes: limits.maxFileBytes, maxOutputBytes: limits.maxBundleBytes / 8, truncated: patch.truncated ?? false });
                comparison.files = result.changes.map(file => ({ ...file, patch: parsed.patches.get(fileKey(file))! }));
                const paths = new Map(result.changes.map(file => [fileKey(file), file.destinationPath]));
                for (const item of parsed.diagnostics) { reasons.push(item.code); diagnostics.push({ code: item.code, message: `${item.fileKey && paths.has(item.fileKey) ? `${JSON.stringify(paths.get(item.fileKey))}: ` : ''}${item.message}`, scope }); }
                const unknownOmissions = patch.truncated || [...parsed.patches.values()].some(file => file.omittedHunks === null) || parsed.diagnostics.some(item => item.fileKey === null);
                comparison.patchCoverage = { source: 'git', retainedBytes: patch.stdout.length, observedBytesLowerBound: patch.observedBytes ?? patch.stdout.length, totalBytes: patch.truncated ? null : patch.stdout.length, truncated: patch.truncated ?? false, observedHunks: parsed.observedHunks, omittedHunks: unknownOmissions ? null : [...parsed.patches.values()].reduce((sum, file) => sum + (file.omittedHunks ?? 0), 0) };
              } catch (error) {
                const code = error instanceof ScanError ? error.code : 'PATCH_FAILED'; reasons.push(code); diagnostics.push({ code, message: error instanceof Error ? error.message : 'Patch collection failed', scope });
                comparison.files = result.changes.map(file => ({ ...file, patch: { state: 'unavailable', representation: 'unsupported', hunks: [], observedHunks: 0, omittedHunks: null, reasons: [code] } }));
              }
              comparison.reasons = [...new Set(reasons)]; comparison.state = reasons.length ? 'partial' : 'complete';
            }
          } catch (error) { reasons.push(error instanceof ScanError ? error.code : 'COMPARISON_FAILED'); diagnostics.push({ code: reasons.at(-1)!, message: error instanceof Error ? error.message : 'Comparison failed', scope }); }
        }
        comparisons.push(comparison);
      }
      if (diff?.symbols) {
        try {
          const { TreeSitterAnalyzer } = await import('../language/tree-sitter.js'); const analyzer = new TreeSitterAnalyzer(diff.java !== false); const analysisBudget = { bytes: 0, symbols: 0 };
          for (const comparison of comparisons) for (const file of comparison.files) if (file.patch) file.languageAnalysis = await analyzeFile(adapter, analyzer, file, file.patch, before, comparison.after.kind === 'working-tree', analysisBudget);
        } catch { diagnostics.push({ code: 'SYMBOL_RUNTIME_UNAVAILABLE', message: 'Language runtime could not load or analyze; Git evidence is retained', scope: diff.scope }); }
      }
      const after = await capture(adapter, config, budget, cliBase, attemptBudget, diff ? { includeUntracked: diff.includeUntracked, retainContent: false } : undefined);
      if (before.guard !== after.guard) throw new ScanError('SNAPSHOT_CHANGED', 'Relevant refs, index, configuration, attributes, status, or files changed during collection', 1);
      const snapshotId = digest(['snapshot-v1', repository.repositoryId, diff?.commits ? { ...before.semantic, revisions } : before.semantic]);
      for (const comparison of comparisons) if (comparison.state !== 'unavailable') comparison.comparisonId = digest(['comparison-v1', snapshotId, comparison.scope, comparison.before, comparison.after, diffOptions]);
      for (const comparison of comparisons) for (const file of comparison.files) for (const hunk of file.patch?.hunks ?? []) hunk.hunkId = digest(['hunk-v1', comparison.comparisonId, fileKey(file), hunk]);
      for (const file of before.untracked) if (file.content?.state === 'collected') file.content.contentId = digest(['filesystem-content-v1', repository.repositoryId, snapshotId, file.pathBytes, file.content.sha256]);
      output.revisions = before.revisions; output.workingTree = before.status; output.untracked = before.untracked; output.excludedUntrackedCount = before.excludedUntrackedCount;
      output.conflicts = conflicts; output.comparisons = comparisons;
      output.fingerprints = { index: before.indexHash, workingTree: before.workingHash, configuration: before.configurationHash, attributes: before.attributesHash };
      output.capabilities = { sparseCheckout: before.sparse, restrictedPaths: before.restrictedPaths, activeFilterPaths: before.activeFilterPaths, intentToAddPaths: before.intentToAdd.map(encoded => ({ path: before.index.find(entry => entry.pathBytes === encoded)?.path ?? null, pathBytes: encoded })), intentToAddPolicy: 'experimental-visible-in-index' };
      const contentReasons = diff?.includeUntracked ? [...before.untracked.flatMap(file => file.content?.reason ? [file.content.reason] : file.path === null ? ['UNSUPPORTED_PATH_ENCODING'] : []), ...!before.status.available ? ['UNTRACKED_CONTENT_UNAVAILABLE'] : []] : [];
      output.reasons = [...new Set([...comparisons.flatMap(item => item.reasons), ...diff ? contentReasons : before.status.reasons, ...adapter.warnings.size ? ['GIT_WARNING'] : []])].sort();
      if (diff && (diff.scope === 'staged' || diff.scope === 'unstaged') && before.revisions.mergeBase.reason) diagnostic(before.revisions.mergeBase.reason, 'Base/branch comparison unavailable; requested local comparison is independent', diff.scope);
      if (diff && !before.status.available) for (const reason of before.status.reasons) if (!output.reasons.includes(reason)) diagnostic(reason, 'Working-tree status unavailable; requested immutable comparison is independent', diff.scope);
      output.state = output.reasons.length ? 'partial' : 'complete';
      output.snapshot.snapshotId = snapshotId; output.snapshot.consistency = 'verified-optimistic';
      for (const item of diagnostics) diagnostic(item.code, item.message, item.scope);
      for (const warning of adapter.warnings) diagnostic('GIT_WARNING', warning);
      for (const code of output.reasons) if (!output.diagnostics.some(item => item.code === code)) diagnostic(code, `Component unavailable or incomplete: ${code}`);
      break;
    } catch (error) {
      const code = error instanceof ScanError ? error.code : 'SNAPSHOT_READ_FAILED';
      if (code === 'SNAPSHOT_CHANGED' && attempt === 1) { diagnostic('SNAPSHOT_RETRY', 'Snapshot changed; discarded the first attempt and retried once'); continue; }
      const failure = code === 'SNAPSHOT_CHANGED' ? 'SNAPSHOT_INCONSISTENT' : code;
      output.reasons = [failure]; output.snapshot.consistency = failure === 'SNAPSHOT_INCONSISTENT' ? 'inconsistent' : 'unverified';
      diagnostic(failure, error instanceof ScanError ? error.message : `Filesystem capture failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`);
      break;
    }
  }
  output.snapshot.bytesHashed = budget.workspaceBytes - initialBytes; output.snapshot.endedAt = new Date().toISOString();
  return output;
}
