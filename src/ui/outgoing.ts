import { ScanError, loadConfig } from '../config/load.js';
import { resolveLimits } from '../config/schema.js';
import { runGit, type GitRunner } from '../git/runner.js';
import type { OutgoingReview, ReviewSelection } from './contracts.js';
import { collectLocalEvidence } from './local.js';

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const decode = (bytes: Buffer) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ScanError('HISTORY_ENCODING_UNSUPPORTED', 'Local history metadata is not valid UTF-8.', 1); }
};

/** Read only local refs; never infer a remote default or contact a server. */
export async function captureOutgoing(root: string, signal: AbortSignal, chosenRef?: string, runner: GitRunner = runGit): Promise<OutgoingReview> {
  const limits = resolveLimits((await loadConfig(root, undefined)).config.limits), deadline = performance.now() + limits.repoTimeoutMs;
  const run = async (args: string[], input?: Buffer) => {
    signal.throwIfAborted(); const remaining = deadline - performance.now();
    if (remaining <= 0) throw new ScanError('REPOSITORY_TIMEOUT', 'Local history capture exceeded its time bound.', 1);
    return runner(root, args, { ...limits, gitTimeoutMs: Math.min(remaining, limits.gitTimeoutMs) }, signal, input);
  };
  const required = async (args: string[], input?: Buffer) => {
    const result = await run(args, input);
    if (result.code !== 0) throw new ScanError('HISTORY_UNAVAILABLE', `Cannot read local history: ${result.stderr.slice(0, 2048)}`, 1);
    return result.stdout;
  };
  const metadata = async () => {
    const symbolic = await run(['symbolic-ref', '--quiet', 'HEAD']);
    if (symbolic.code !== 0 && symbolic.code !== 1) throw new ScanError('HEAD_UNRESOLVED', 'Cannot read the current branch.', 1);
    const branchRef = symbolic.code === 0 ? decode(symbolic.stdout).trimEnd() : null;
    const headResult = await run(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
    const head = headResult.code === 0 ? decode(headResult.stdout).trimEnd() : null;
    if (head && !oidPattern.test(head)) throw new ScanError('HISTORY_INVALID', 'Invalid captured HEAD ID.', 1);
    const refs = decode(await required(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)', 'refs/heads/', 'refs/remotes/', 'refs/tags/']));
    const upstream = branchRef ? decode(await required(['for-each-ref', '--format=%(upstream)', branchRef])).trimEnd() : '';
    // Includes configuration: removing a tracking setting during capture must
    // not look like a valid snapshot of the previous upstream relationship.
    const config = await required(['config', '--null', '--list']);
    const shallow = decode(await required(['rev-parse', '--is-shallow-repository'])).trimEnd() === 'true';
    const shallowPath = decode(await required(['rev-parse', '--git-path', 'shallow'])).trimEnd();
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    let boundary = '';
    try { boundary = (await readFile(path.resolve(root, shallowPath))).toString('hex'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { branchRef, head, refs, upstream, configuration: config.toString('hex'), shallow, boundary };
  };
  const before = await metadata();
  const refs = before.refs.split('\n').filter(Boolean).flatMap(line => {
    const [ref, oid, type, peeled, peeledType] = line.split('\0');
    const commit = type === 'commit' ? oid : peeledType === 'commit' ? peeled : null;
    if (!ref || !commit || !oidPattern.test(commit)) return [];
    return [{ ref, oid: commit }];
  });
  if (refs.length > 10_000) throw new ScanError('HISTORY_REF_LIMIT', 'Local comparison refs exceed the 10,000 ref bound.', 1);
  const selected = chosenRef ? refs.find(item => item.ref === chosenRef) : refs.find(item => item.ref === before.upstream);
  if (chosenRef && !selected) throw new ScanError('COMPARISON_REF_MISSING', 'The chosen local comparison ref is missing. Select an available ref and refresh.', 1);
  const branch = before.branchRef?.replace(/^refs\/heads\//u, '') ?? null;
  const review: OutgoingReview = { head: before.head, branch, detached: !before.branchRef, shallow: before.shallow, comparison: selected ? { ...selected, kind: chosenRef ? 'chosen' : 'upstream' } : null,
    refs, status: !before.head ? 'unborn' : !selected ? before.upstream ? 'missing-upstream' : before.branchRef ? 'no-upstream' : 'detached' : 'ready',
    upstreamRef: before.upstream || null, ahead: null, behind: null, diverged: false, commits: [], complete: true, omittedCommits: 0, mergeBases: [], aggregateReason: null, capturedAt: new Date().toISOString() };
  if (before.head && selected) {
    const counts = decode(await required(['rev-list', '--left-right', '--count', `${before.head}...${selected.oid}`])).trim().split(/\s+/u).map(Number);
    if (counts.length !== 2 || counts.some(value => !Number.isSafeInteger(value) || value < 0)) throw new ScanError('HISTORY_INVALID', 'Invalid ahead/behind counts.', 1);
    review.ahead = counts[0]!; review.behind = counts[1]!; review.diverged = review.ahead > 0 && review.behind > 0;
    const merge = await run(['merge-base', '--all', selected.oid, before.head]);
    if (merge.code !== 0 && merge.code !== 1) throw new ScanError('MERGE_BASE_FAILED', 'Cannot determine a local merge base.', 1);
    review.mergeBases = decode(merge.stdout).trim().split('\n').filter(Boolean).sort();
    if (review.mergeBases.some(oid => !oidPattern.test(oid))) throw new ScanError('HISTORY_INVALID', 'Invalid merge base ID.', 1);
    review.aggregateReason = review.mergeBases.length === 0 ? before.shallow ? 'Shallow history does not contain a common ancestor. Aggregate review is unavailable.' : 'These histories have no common ancestor. Aggregate review is unavailable.' : review.mergeBases.length > 1 ? 'Multiple merge bases exist. Aggregate review requires a unique merge base.' : null;
    const bytes = await required(['log', '--topo-order', '--no-show-signature', '--no-notes', '--no-decorate', '--format=%H%x00%P%x00%s%x00%an%x00%aI', '-z', '--max-count=501', before.head, `^${selected.oid}`, '--']);
    const fields = decode(bytes).split('\0'); if (fields.at(-1) === '') fields.pop();
    if (fields.length % 5) throw new ScanError('HISTORY_INVALID', 'Malformed commit display metadata.', 1);
    for (let i = 0; i < fields.length && review.commits.length < 500; i += 5) {
      const [oid, _parents, subject, author, date] = fields.slice(i, i + 5);
      if (!oid || !oidPattern.test(oid)) throw new ScanError('HISTORY_INVALID', 'Invalid outgoing commit ID.', 1);
      review.commits.push({ oid, shortOid: oid.slice(0, 12), subject: subject!, author: author!, date: date!, parents: [], unavailableReason: null });
    }
    review.omittedCommits = Math.max(0, review.ahead - review.commits.length); review.complete = review.omittedCommits === 0;
    // Read raw parent headers: revision traversal hides parents at shallow
    // boundaries and must never turn a shallow commit into a root commit.
    if (review.commits.length) {
      const batch = await required(['cat-file', '--batch'], Buffer.from(review.commits.map(commit => commit.oid).join('\n') + '\n'));
      let cursor = 0;
      for (const commit of review.commits) {
        const end = batch.indexOf(10, cursor); const header = batch.subarray(cursor, end).toString('ascii');
        const parts = header.split(' '), size = Number(parts[2]);
        if (end < 0 || parts[0] !== commit.oid || parts[1] !== 'commit' || !Number.isSafeInteger(size) || size < 0 || end + 1 + size >= batch.length) throw new ScanError('HISTORY_INVALID', 'Incomplete commit object metadata.', 1);
        const object = batch.subarray(end + 1, end + 1 + size); const headerEnd = object.indexOf(Buffer.from('\n\n'));
        if (headerEnd < 0) throw new ScanError('HISTORY_INVALID', 'Malformed commit object headers.', 1);
        commit.parents = object.subarray(0, headerEnd).toString('ascii').split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
        if (commit.parents.some(parent => !oidPattern.test(parent))) throw new ScanError('HISTORY_INVALID', 'Invalid parent ID.', 1);
        cursor = end + size + 2;
      }
      if (cursor !== batch.length) throw new ScanError('HISTORY_INVALID', 'Unexpected commit batch bytes.', 1);
      const parents = [...new Set(review.commits.flatMap(commit => commit.parents.slice(0, 1)))];
      if (parents.length) {
        const available = decode(await required(['cat-file', '--batch-check=%(objectname) %(objecttype)'], Buffer.from(parents.join('\n') + '\n'))).trimEnd().split('\n');
        const missing = new Set(parents.filter((parent, index) => available[index] !== `${parent} commit`));
        for (const commit of review.commits) if (commit.parents[0] && missing.has(commit.parents[0])) commit.unavailableReason = 'First parent object is unavailable locally (possibly shallow history). This is not a root commit.';
      }
    }
    if (review.ahead === 0) review.status = 'empty';
  }
  if (JSON.stringify(before) !== JSON.stringify(await metadata())) throw new ScanError('OUTGOING_CHANGED', 'HEAD, local refs, upstream configuration or shallow history changed during capture. Click Refresh to recapture.', 1);
  signal.throwIfAborted(); return review;
}

export async function collectOutgoingEvidence(root: string, review: OutgoingReview, selection: ReviewSelection, signal: AbortSignal) {
  if (!review.head || !review.comparison) return null;
  let before: string, after: string, emptyBefore = false;
  if (selection.commit === null) {
    if (review.aggregateReason || review.ahead === 0) return null;
    before = review.mergeBases[0]!; after = review.head;
  } else {
    const commit = review.commits.find(item => item.oid === selection.commit);
    if (!commit) throw new ScanError('COMMIT_NOT_CAPTURED', 'Select a commit in the captured outgoing list.', 1);
    if (commit.unavailableReason) return null;
    after = commit.oid; emptyBefore = commit.parents.length === 0;
    before = commit.parents[0] ?? decode((await runGit(root, ['hash-object', '-t', 'tree', '--stdin'], resolveLimits((await loadConfig(root, undefined)).config.limits), signal, Buffer.alloc(0))).stdout).trimEnd();
    if (!oidPattern.test(before)) throw new ScanError('EMPTY_TREE_UNAVAILABLE', 'Cannot determine the empty-tree ID.', 1);
  }
  return collectLocalEvidence(root, signal, { before, after, emptyBefore });
}
