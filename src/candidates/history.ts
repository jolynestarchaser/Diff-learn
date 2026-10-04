import type { RepositoryStatus } from '../git/collector.js';
import type { Limits } from '../config/schema.js';
import { GitAdapter } from '../git/adapter.js';
import { runGit, type GitRunner } from '../git/runner.js';

export type HistoryResult = { outcome: 'commits' | 'no-commits' | 'unborn' | 'execution-error' | 'truncated'; headOid: string | null; paths: string[]; arguments: string[]; commits: { oid: string; parents: string[] }[]; truncated: boolean; shallow: boolean; reasons: string[] };
export async function collectHistory(repository: RepositoryStatus, paths: string[], limit: number, limits: Limits, signal?: AbortSignal, runner: GitRunner = runGit, deadline = performance.now() + limits.repoTimeoutMs): Promise<HistoryResult> {
  const head = repository.revisions?.head.oid ?? null; const literalPaths = [...new Set(paths)].sort();
  const args = ['--literal-pathspecs', '-c', 'log.follow=false', '-c', 'log.showRoot=true', 'log', '--no-ext-diff', '--no-textconv', '--no-patch', '--no-color', '--no-abbrev-commit', '--no-use-mailmap', '--no-decorate', '--no-show-signature', '--no-notes', '--no-renames', '--topo-order', `--max-count=${limit + 1}`, '--format=%H%x00%P', '-z', '--end-of-options', ...(head ? [head] : []), '--', ...literalPaths];
  const result: HistoryResult = { outcome: head ? 'no-commits' : 'unborn', headOid: head, paths: literalPaths, arguments: args, commits: [], truncated: false, shallow: repository.revisions?.mergeBase.shallow ?? false, reasons: [] };
  if (!head) return result;
  try {
    const adapter = new GitAdapter(repository, limits, deadline, signal, runner); const output = await adapter.run(args, undefined, { limit: Math.min(limits.maxMetadataBytes, 1024 * 1024), retainPrefix: true });
    if (output.code !== 0 && !output.truncated) throw new Error('History query failed');
    const completeBytes = output.truncated ? output.stdout.subarray(0, output.stdout.lastIndexOf(0) + 1) : output.stdout;
    const fields = completeBytes.toString('ascii').split('\0'); if (fields.at(-1) === '') fields.pop();
    if (output.truncated) fields.splice(fields.length - fields.length % 2);
    if (fields.length % 2) throw new Error('Incomplete history record');
    for (let index = 0; index < fields.length; index += 2) { const oid = fields[index]!, parents = fields[index + 1]!.split(' ').filter(Boolean); if (![oid, ...parents].every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value))) throw new Error('Invalid history object ID'); result.commits.push({ oid, parents }); }
    result.truncated = output.truncated === true || result.commits.length > limit; result.commits = result.commits.slice(0, limit); result.outcome = result.truncated ? 'truncated' : result.commits.length ? 'commits' : 'no-commits';
    if (result.truncated) result.reasons.push('HISTORY_RESULT_LIMIT'); if (result.shallow) result.reasons.push('HISTORY_SHALLOW');
  } catch (error) { if (signal?.aborted) throw error; result.outcome = 'execution-error'; result.commits = []; result.reasons = ['HISTORY_EXECUTION_ERROR']; }
  return result;
}
