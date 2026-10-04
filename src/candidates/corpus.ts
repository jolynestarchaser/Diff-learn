import { createHash } from 'node:crypto';
import type { Config, Limits } from '../config/schema.js';
import { ScanError } from '../config/load.js';
import { GitAdapter } from '../git/adapter.js';
import type { RepositoryStatus } from '../git/collector.js';
import { builtInExcludes } from '../git/discovery.js';
import { gitPath, nulRecords } from '../git/metadata.js';
import { runGit, type GitRunner } from '../git/runner.js';
import { capture, digest, type SnapshotBudget } from '../git/snapshot.js';
import type { Corpus, CorpusFile } from './contracts.js';

export async function collectCorpus(repositories: RepositoryStatus[], config: Config, limits: Limits, budget: SnapshotBudget, cliBase?: string, signal?: AbortSignal, runner: GitRunner = runGit, deadline = performance.now() + limits.repoTimeoutMs): Promise<Corpus> {
  const result: Corpus = { files: [], reasons: [], diagnostics: [], excludedFiles: 0, omittedFiles: 0, snapshotIds: [] };
  const excludes = new Set([...builtInExcludes, ...config.excludeDirectories ?? []]);
  const addReason = (code: string, repo: RepositoryStatus, message: string) => { result.reasons.push(code); result.diagnostics.push({ code, repositoryId: repo.repositoryId, path: repo.path, message }); };
  for (const repo of repositories) {
    const comparison = repo.comparisons[0];
    if (!repo.snapshot.snapshotId || !comparison?.comparisonId || repo.kind !== 'worktree') { addReason('CANDIDATE_SNAPSHOT_UNAVAILABLE', repo, 'No verified comparison snapshot for candidate discovery'); continue; }
    const adapter = new GitAdapter(repo, limits, Math.min(deadline, performance.now() + limits.repoTimeoutMs), signal, runner);
    const files: CorpusFile[] = []; const initialOmissions = result.omittedFiles;
    try {
      const working = comparison.after.kind === 'working-tree';
      const before = await capture(adapter, config, budget, cliBase, { bytes: 0 }, { includeUntracked: repo.untracked.some(file => file.contentPolicy === 'opt-in-text'), retainContent: false, retainAllTracked: working });
      if (digest(['snapshot-v1', repo.repositoryId, before.semantic]) !== repo.snapshot.snapshotId) throw new ScanError('CANDIDATE_SNAPSHOT_CHANGED', 'Repository changed since symbol collection; candidate corpus withheld', 1);
      const entries = comparison.after.kind === 'commit' ? nulRecords(await adapter.required(['ls-tree', '-r', '-z', '--full-tree', comparison.after.oid!])).map(record => {
        const tab = record.indexOf(9); const fields = record.subarray(0, tab).toString('ascii').split(' ');
        if (tab < 0 || fields.length !== 3) throw new ScanError('CANDIDATE_TREE_INVALID', 'Invalid tree metadata', 1);
        return { ...gitPath(record.subarray(tab + 1)), mode: fields[0]!, oid: fields[2]!, stage: 0 };
      }) : before.index;
      const conflicted = new Set(entries.filter(entry => entry.stage !== 0).map(entry => entry.pathBytes)); let retainedBytes = 0; let considered = 0;
      result.omittedFiles += conflicted.size;
      const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.pathBytes, 'base64'), Buffer.from(b.pathBytes, 'base64')));
      for (const entry of sorted) {
        if (entry.stage !== 0) continue;
        const relative = entry.path; const workspacePath = repo.path === '.' ? relative : `${repo.path}/${relative}`;
        if (relative !== null && (relative.split('/').some(part => excludes.has(part)) || (config.excludePaths ?? []).some(excluded => workspacePath === excluded || workspacePath?.startsWith(`${excluded}/`)) || repo.submodules.some(module => relative === module.path || relative.startsWith(`${module.path}/`)) || repositories.some(child => child.repositoryId !== repo.repositoryId && child.path.startsWith(repo.path === '.' ? '' : `${repo.path}/`) && (workspacePath === child.path || workspacePath?.startsWith(`${child.path}/`))))) { result.excludedFiles++; continue; }
        if (!/^100[0-7]{3}$/u.test(entry.mode)) { result.excludedFiles++; continue; }
        if (relative === null || conflicted.has(entry.pathBytes)) { result.omittedFiles++; continue; }
        if (++considered > Math.min(limits.maxFiles, 500) || result.files.length + files.length >= Math.min(limits.maxFiles, 500)) { result.omittedFiles++; continue; }
        let bytes: Buffer | undefined;
        if (working) bytes = before.trackedContents.get(entry.pathBytes);
        else {
          const size = Number((await adapter.required(['cat-file', '-s', entry.oid])).toString('ascii').trim());
          if (!Number.isSafeInteger(size) || size < 0) throw new ScanError('CANDIDATE_BLOB_INVALID', 'Invalid blob size', 1);
          if (size <= limits.maxFileBytes && retainedBytes + size + result.files.reduce((sum, file) => sum + file.bytes.length, 0) <= limits.maxPatchBytes) { const blob = await adapter.run(['cat-file', 'blob', entry.oid], undefined, { limit: limits.maxFileBytes, retainPrefix: false }); if (blob.code !== 0 || blob.stdout.length !== size) throw new ScanError('CANDIDATE_BLOB_FAILED', 'Cannot read exact blob', 1); bytes = blob.stdout; }
        }
        if (!bytes || retainedBytes + bytes.length + result.files.reduce((sum, file) => sum + file.bytes.length, 0) > limits.maxPatchBytes) { result.omittedFiles++; continue; }
        try { if (bytes.includes(0) || !Buffer.from(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)).equals(bytes)) { result.excludedFiles++; continue; } } catch { result.excludedFiles++; continue; }
        retainedBytes += bytes.length;
        files.push({ snapshot: { repositoryId: repo.repositoryId, snapshotId: repo.snapshot.snapshotId, comparisonId: comparison.comparisonId, corpusId: '', path: relative, pathBytes: entry.pathBytes, origin: working ? 'filesystem' : 'git-blob', endpoint: working ? 'working-tree' : comparison.after.kind === 'commit' ? 'commit' : 'index', oid: working ? null : entry.oid, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length }, bytes });
      }
      const after = await capture(adapter, config, budget, cliBase, { bytes: 0 }, { includeUntracked: repo.untracked.some(file => file.contentPolicy === 'opt-in-text'), retainContent: false });
      if (before.guard !== after.guard) throw new ScanError('CANDIDATE_SNAPSHOT_CHANGED', 'Repository changed during corpus collection; candidate corpus withheld', 1);
      const corpusId = digest(['candidate-corpus-v1', repo.repositoryId, repo.snapshot.snapshotId, comparison.comparisonId, files.map(file => file.snapshot)]);
      for (const file of files) file.snapshot.corpusId = corpusId;
      result.snapshotIds.push(corpusId); result.files.push(...files);
      if (result.omittedFiles > initialOmissions) addReason('CANDIDATE_SOURCE_LIMIT', repo, 'Some tracked sources omitted by path, conflict, file-count, size, or retention limits');
    } catch (error) { if (signal?.aborted) throw error; addReason(error instanceof ScanError ? error.code : 'CANDIDATE_CAPTURE_FAILED', repo, error instanceof Error ? error.message : 'Candidate capture failed'); result.omittedFiles += files.length; }
  }
  result.reasons = [...new Set(result.reasons)].sort(); return result;
}
