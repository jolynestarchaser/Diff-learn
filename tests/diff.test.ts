import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, rename, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveLimits, type Config, type Limits } from '../src/config/schema.js';
import { canonicalRoot, discover } from '../src/git/discovery.js';
import { collectRepository, type RepositoryStatus } from '../src/git/collector.js';
import { patchOptions, diffOptions, type Scope } from '../src/git/adapter.js';
import { runGit, type GitRunner } from '../src/git/runner.js';
import { parseRaw, joinNumstat, type FileChange } from '../src/git/metadata.js';
import { parseUnified, fileKey, type FilePatch, type PatchBounds } from '../src/diff/unified.js';

const entrypoint = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const limits = resolveLimits(undefined);
const bounds: PatchBounds = { maxHunks: limits.maxHunks, maxFileBytes: limits.maxFileBytes, maxOutputBytes: limits.maxBundleBytes / 8 };
function gitInput(cwd: string, args: string[], input?: Buffer): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', '-c', 'core.quotePath=true', '-c', 'diff.suppressBlankEmpty=false', ...args], { cwd, env, shell: false, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, ...(input ? { input } : {}) });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr.toString()); return result.stdout;
}
const git = (cwd: string, ...args: string[]) => gitInput(cwd, args);
async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'difflearn-diff-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function init(root: string, committed = true) {
  git(root, 'init', '-b', 'main'); git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'user.name', 'Synthetic'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(root, '.git', 'fixture-ignore'), ''); await writeFile(path.join(root, '.git', 'fixture-attributes'), '');
  git(root, 'config', 'core.excludesFile', '.git/fixture-ignore'); git(root, 'config', 'core.attributesFile', '.git/fixture-attributes');
  if (committed) { await writeFile(path.join(root, 'file.txt'), 'base\n'); git(root, 'add', '--', 'file.txt'); git(root, 'commit', '-m', 'base'); git(root, 'branch', 'base'); }
}
function direct(root: string, args: string[], binaryPayload = false) {
  const files = parseRaw(git(root, 'diff', ...diffOptions, '--raw', '-z', ...args, '--'));
  joinNumstat(files, git(root, 'diff', ...diffOptions, '--numstat', '-z', ...args, '--'));
  const bytes = git(root, 'diff', ...patchOptions, ...binaryPayload ? ['--binary'] : [], ...args, '--');
  return { files, bytes, parsed: parseUnified(bytes, files, bounds) };
}
async function collect(root: string, scope: Scope, options: { includeUntracked?: boolean; base?: string | null; limits?: Limits; runner?: GitRunner } = {}) {
  const actual = await canonicalRoot(root); const config: Config = { configVersion: '1' }; const chosen = options.limits ?? limits;
  const found = await discover(actual, config, chosen);
  return collectRepository(found.repositories[0]!, config, chosen, { workspaceBytes: 0 }, options.base === null ? undefined : options.base ?? 'base', undefined, options.runner ?? runGit, { scope, includeUntracked: options.includeUntracked ?? false });
}
function selected(repo: RepositoryStatus) { assert.equal(repo.comparisons.length, 1); return repo.comparisons[0]!; }
function blob(root: string, oid: string | null) { return oid ? git(root, 'cat-file', 'blob', oid) : Buffer.alloc(0); }
function lines(bytes: Buffer) { const result = bytes.toString('utf8').split('\n'); if (bytes.at(-1) === 10) result.pop(); if (!bytes.length) result.length = 0; return result; }
async function verify(root: string, file: FileChange, patch: FilePatch, working = false) {
  if (file.binary || file.kind === 'gitlink') { assert.equal(patch.hunks.length, 0); return; }
  assert.equal(patch.state, 'complete', JSON.stringify(patch));
  const old = blob(root, file.oldOid);
  const fresh = file.status === 'D' ? Buffer.alloc(0) : working ? await readFile(path.join(root, file.destinationPath!)) : blob(root, file.newOid);
  const oldLines = lines(old), newLines = lines(fresh);
  let additions = 0, removals = 0;
  for (const hunk of patch.hunks) {
    assert.equal(hunk.lines.filter(line => line.kind !== 'add').length, hunk.oldCount);
    assert.equal(hunk.lines.filter(line => line.kind !== 'remove').length, hunk.newCount);
    for (const line of hunk.lines) {
      assert.equal(Buffer.from(line.contentBytes, 'base64').toString('utf8'), line.content);
      if (line.oldLine !== null) { assert.equal(line.content, oldLines[line.oldLine - 1]); assert.equal(line.oldNoNewline, line.oldLine === oldLines.length && old.at(-1) !== 10); }
      if (line.newLine !== null) { assert.equal(line.content, newLines[line.newLine - 1]); assert.equal(line.newNoNewline, line.newLine === newLines.length && fresh.at(-1) !== 10); }
      if (line.kind === 'add') additions++; if (line.kind === 'remove') removals++;
    }
  }
  assert.equal(additions, file.added); assert.equal(removals, file.deleted);
}

test('real Git hunks preserve ranges, CRLF bytes, repeated content, no-newline markers, empty and Unicode paths', async () => fixture(async root => {
  await init(root);
  const repeated = Array.from({ length: 60 }, (_, index) => `anchor ${index}`);
  for (const center of [10, 40]) for (let offset = -3; offset <= 3; offset++) repeated[center + offset] = offset === 0 ? 'old' : `same context ${offset}`;
  await writeFile(path.join(root, 'repeat space.txt'), repeated.join('\n') + '\n');
  await writeFile(path.join(root, 'crlf ไทย.txt'), 'first\r\nsecond\r\nlast');
  await writeFile(path.join(root, 'deleted.txt'), 'gone\n'); await writeFile(path.join(root, 'no-lf.txt'), 'old');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'seed');
  repeated[10] = 'changed'; repeated[40] = 'changed';
  await writeFile(path.join(root, 'repeat space.txt'), repeated.join('\n') + '\n');
  await writeFile(path.join(root, 'crlf ไทย.txt'), 'first\r\nSECOND\r\nlast');
  await writeFile(path.join(root, 'no-lf.txt'), 'new'); await writeFile(path.join(root, 'added ไทย.txt'), 'added\n'); await writeFile(path.join(root, 'empty.txt'), '');
  git(root, 'rm', '--', 'deleted.txt'); git(root, 'add', '.');
  const result = direct(root, ['--cached', 'HEAD']); assert.deepEqual(result.parsed.diagnostics, []);
  for (const file of result.files) await verify(root, file, result.parsed.patches.get(fileKey(file))!);
  const repeatedPatch = result.parsed.patches.get(fileKey(result.files.find(file => file.destinationPath === 'repeat space.txt')!))!;
  assert.equal(repeatedPatch.hunks.length, 2); assert.deepEqual(repeatedPatch.hunks.map(hunk => hunk.ordinal), [1, 2]);
  assert.deepEqual(repeatedPatch.hunks[0]!.lines.map(line => [line.kind, line.contentBytes]), repeatedPatch.hunks[1]!.lines.map(line => [line.kind, line.contentBytes]), 'identical content at distinct ranges is never deduplicated');
  const addition = result.parsed.patches.get(fileKey(result.files.find(file => file.destinationPath === 'added ไทย.txt')!))!; assert.equal(addition.hunks[0]?.oldCount, 0); assert.equal(addition.hunks[0]?.oldStart, 0);
  const deletion = result.parsed.patches.get(fileKey(result.files.find(file => file.destinationPath === 'deleted.txt')!))!; assert.equal(deletion.hunks[0]?.newCount, 0);
  assert.equal(result.parsed.patches.get(fileKey(result.files.find(file => file.destinationPath === 'empty.txt')!))!.hunks.length, 0);
}));

test('pure and modified renames retain authoritative original/destination paths and counts', async () => fixture(async root => {
  await init(root); await writeFile(path.join(root, 'modified old.txt'), Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n') + '\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'seed');
  await rename(path.join(root, 'file.txt'), path.join(root, 'pure ไทย.txt'));
  await rename(path.join(root, 'modified old.txt'), path.join(root, 'modified ไทย new.txt'));
  await writeFile(path.join(root, 'modified ไทย new.txt'), Array.from({ length: 20 }, (_, index) => index === 10 ? 'edited' : `line ${index}`).join('\n') + '\n'); git(root, 'add', '-A');
  const result = direct(root, ['--cached', 'HEAD']); assert.deepEqual(result.parsed.diagnostics, []); assert.equal(result.files.filter(file => file.status === 'R').length, 2);
  for (const file of result.files) await verify(root, file, result.parsed.patches.get(fileKey(file))!);
  assert.equal(result.parsed.patches.get(fileKey(result.files.find(file => file.similarity === 100)!))!.hunks.length, 0);
  const ambiguous = path.join(root, 'ambiguous'); await mkdir(ambiguous); await init(ambiguous); await mkdir(path.join(ambiguous, 'foo b')); await mkdir(path.join(ambiguous, 'bar b'));
  await writeFile(path.join(ambiguous, 'foo b', 'bar'), 'first distinct\n'); await writeFile(path.join(ambiguous, 'foo'), 'second distinct\n'); git(ambiguous, 'add', '.'); git(ambiguous, 'commit', '-m', 'ambiguous names');
  await rename(path.join(ambiguous, 'foo b', 'bar'), path.join(ambiguous, 'baz')); await rename(path.join(ambiguous, 'foo'), path.join(ambiguous, 'bar b', 'baz')); git(ambiguous, 'add', '-A');
  const sharedHeader = direct(ambiguous, ['--cached']); assert.equal(sharedHeader.files.filter(file => file.status === 'R').length, 2); assert.deepEqual(sharedHeader.parsed.diagnostics, []); for (const file of sharedHeader.files) await verify(ambiguous, file, sharedHeader.parsed.patches.get(fileKey(file))!);
}));

test('Git tree fixtures generate quoted tab paths even on Windows without creating an invalid native filename', async () => fixture(async root => {
  await init(root); const head = git(root, 'rev-parse', 'HEAD').toString().trim();
  const content = Buffer.from('tab path text\n'); const oid = gitInput(root, ['hash-object', '-w', '--stdin'], content).toString().trim();
  const tree = gitInput(root, ['mktree', '-z'], Buffer.concat([git(root, 'ls-tree', '-z', 'HEAD'), Buffer.from(`100644 blob ${oid}\ttab\tไทย.txt\0`)])).toString().trim();
  const commit = gitInput(root, ['commit-tree', tree, '-p', head], Buffer.from('synthetic tab tree\n')).toString().trim();
  const result = direct(root, [head, commit]); assert.deepEqual(result.parsed.diagnostics, []); assert.equal(result.files[0]?.destinationPath, 'tab\tไทย.txt');
  await verify(root, result.files[0]!, result.parsed.patches.get(fileKey(result.files[0]!))!);
  assert.ok(result.bytes.includes(Buffer.from('\\t')));
}));

test('real Git non-UTF-8 text retains lossless bytes with null display text; mode-only changes have no hunks', async () => fixture(async root => {
  await init(root); await writeFile(path.join(root, 'encoded.txt'), Buffer.from([255, 10])); git(root, 'add', '.'); git(root, 'commit', '-m', 'encoded'); await writeFile(path.join(root, 'encoded.txt'), Buffer.from([254, 10])); git(root, 'add', '.');
  const result = direct(root, ['--cached']); assert.deepEqual(result.parsed.diagnostics, []); const patch = [...result.parsed.patches.values()][0]!; assert.equal(patch.state, 'complete'); assert.equal(patch.hunks[0]?.lines[0]?.content, null); assert.deepEqual(Buffer.from(patch.hunks[0]!.lines[0]!.contentBytes, 'base64'), Buffer.from([255]));
  const head = git(root, 'rev-parse', 'HEAD').toString().trim(); const treeBytes = git(root, 'ls-tree', '-z', 'HEAD');
  const tree = gitInput(root, ['mktree', '-z'], Buffer.from(treeBytes.toString().replace('100644 blob', '100755 blob'))).toString().trim();
  const commit = gitInput(root, ['commit-tree', tree, '-p', head], Buffer.from('mode\n')).toString().trim(); const mode = direct(root, [head, commit]); assert.deepEqual(mode.parsed.diagnostics, []); assert.equal(mode.files[0]?.oldMode, '100644'); assert.equal(mode.files[0]?.newMode, '100755'); assert.equal([...mode.parsed.patches.values()][0]?.hunks.length, 0);
}));

test('Git type-change sections remain one authoritative file with ordered delete/add hunks', async () => fixture(async root => {
  await init(root); const head = git(root, 'rev-parse', 'HEAD').toString().trim(); const link = gitInput(root, ['hash-object', '-w', '--stdin'], Buffer.from('target.txt')).toString().trim();
  const tree = gitInput(root, ['mktree', '-z'], Buffer.from(`120000 blob ${link}\tfile.txt\0`)).toString().trim(); const commit = gitInput(root, ['commit-tree', tree, '-p', head], Buffer.from('link type\n')).toString().trim();
  const result = direct(root, [head, commit]); assert.equal(result.files.length, 1); assert.equal(result.files[0]?.status, 'T'); assert.deepEqual(result.parsed.diagnostics, []); await verify(root, result.files[0]!, [...result.parsed.patches.values()][0]!); assert.equal([...result.parsed.patches.values()][0]?.hunks.length, 2);
}));

test('binary Git patches remain metadata; binary payload and combined conflict formats have diagnostics', async () => fixture(async root => {
  await init(root); await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2])); git(root, 'add', '.'); git(root, 'commit', '-m', 'binary'); await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 3, 4])); git(root, 'add', '.');
  const normal = direct(root, ['--cached']); assert.deepEqual(normal.parsed.diagnostics, []); const patch = normal.parsed.patches.get(fileKey(normal.files[0]!))!; assert.equal(patch.representation, 'binary'); assert.equal(patch.state, 'metadata-only'); assert.equal(patch.hunks.length, 0);
  const binary = direct(root, ['--cached'], true); assert.ok(binary.bytes.includes(Buffer.from('GIT binary patch'))); assert.ok(binary.parsed.diagnostics.some(item => item.code === 'BINARY_PAYLOAD_NOT_EXPORTED'));
  git(root, 'reset', '--hard', 'HEAD'); git(root, 'checkout', '-b', 'feature'); await writeFile(path.join(root, 'file.txt'), 'ours\n'); git(root, 'commit', '-am', 'ours'); git(root, 'checkout', 'main'); await writeFile(path.join(root, 'file.txt'), 'theirs\n'); git(root, 'commit', '-am', 'theirs'); git(root, 'checkout', 'feature');
  assert.equal(spawnSync('git', ['merge', 'main'], { cwd: root, shell: false }).status, 1);
  const combined = git(root, 'diff', '--no-ext-diff', '--no-textconv'); assert.ok(combined.includes(Buffer.from('diff --cc')));
  assert.ok(parseUnified(combined, [], bounds).diagnostics.some(item => item.code === 'UNSUPPORTED_COMBINED_PATCH'));
  await writeFile(path.join(root, 'safe.txt'), 'safe\n'); git(root, 'add', '--', 'safe.txt');
  const collected = await collect(root, 'staged'); assert.equal(collected.state, 'partial'); assert.ok(collected.reasons.includes('UNMERGED_PATH')); assert.equal(selected(collected).files[0]?.destinationPath, 'safe.txt'); assert.equal(selected(collected).files[0]?.patch?.hunks.length, 1);
}));

test('parser limits and malformed/truncated real patches omit whole hunks with explicit coverage', async () => fixture(async root => {
  await init(root); const original = Array.from({ length: 80 }, (_, index) => `line ${index}`); await writeFile(path.join(root, 'file.txt'), original.join('\n') + '\n'); git(root, 'commit', '-am', 'seed'); original[0] = 'one'; original[40] = 'two'; await writeFile(path.join(root, 'file.txt'), original.join('\n') + '\n'); git(root, 'add', '.');
  const result = direct(root, ['--cached']);
  for (const [changes, code] of [[{ maxHunks: 1 }, 'HUNK_LIMIT'], [{ maxFileBytes: 30 }, 'PATCH_FILE_LIMIT'], [{ maxOutputBytes: 10 }, 'PATCH_OUTPUT_LIMIT']] as const) {
    const parsed = parseUnified(result.bytes, result.files, { ...bounds, ...changes }); const patch = [...parsed.patches.values()][0]!;
    assert.ok(parsed.diagnostics.some(item => item.code === code)); assert.ok((patch.omittedHunks ?? 0) > 0);
    for (const hunk of patch.hunks) { assert.equal(hunk.lines.filter(line => line.kind !== 'add').length, hunk.oldCount); assert.equal(hunk.lines.filter(line => line.kind !== 'remove').length, hunk.newCount); }
  }
  const malformed = Buffer.from(result.bytes.toString().replace(/@@ -1,4/u, '@@ -1,99')); assert.ok(parseUnified(malformed, result.files, bounds).diagnostics.some(item => item.code === 'HUNK_INVALID'));
  const cutoff = parseUnified(result.bytes.subarray(0, result.bytes.length - 12), result.files, { ...bounds, truncated: true }); assert.ok(cutoff.diagnostics.some(item => item.code === 'PATCH_TRUNCATED')); assert.equal([...cutoff.patches.values()][0]?.omittedHunks, null); assert.equal([...cutoff.patches.values()][0]?.hunks.length, 1, 'an incomplete final hunk does not discard an earlier complete hunk');
  const missing = parseUnified(Buffer.alloc(0), result.files, bounds); assert.ok(missing.diagnostics.some(item => item.code === 'PATCH_SECTION_MISSING'));
  const wrongPath = parseUnified(Buffer.from(result.bytes.toString().replace('--- a/file.txt', '--- a/wrong.txt')), result.files, bounds); assert.ok(wrongPath.diagnostics.some(item => item.code === 'PATCH_PATH_MISMATCH')); assert.equal([...wrongPath.patches.values()][0]?.hunks.length, 0);
  const wrongCounts = parseUnified(result.bytes, result.files.map(file => ({ ...file, added: file.added! + 1 })), bounds); assert.ok(wrongCounts.diagnostics.some(item => item.code === 'PATCH_COUNT_MISMATCH'));
  await writeFile(path.join(root, 'file.txt'), 'x'.repeat(4096) + '\n'); git(root, 'add', '.'); const longLine = direct(root, ['--cached']);
  const longBound = parseUnified(longLine.bytes, longLine.files, { ...bounds, maxFileBytes: 1024 }); assert.ok(longBound.diagnostics.some(item => item.code === 'PATCH_FILE_LIMIT')); assert.equal([...longBound.patches.values()][0]?.hunks.length, 0);
}));

test('collector requests every comparison directly; all cancellation never concatenates other scopes', async () => fixture(async root => {
  await init(root); await writeFile(path.join(root, 'file.txt'), 'committed\n'); git(root, 'commit', '-am', 'feature'); await writeFile(path.join(root, 'file.txt'), 'staged\n'); git(root, 'add', '.'); await writeFile(path.join(root, 'file.txt'), 'base\n');
  for (const scope of ['branch', 'staged', 'unstaged', 'all'] as const) {
    const calls: string[][] = []; const runner: GitRunner = async (...args) => { calls.push(args[1]); return runGit(...args); };
    const repo = await collect(root, scope, { runner }); assert.equal(repo.state, 'complete', JSON.stringify(repo.diagnostics)); const comparison = selected(repo);
    const args = scope === 'branch' ? [repo.revisions!.mergeBase.oid!, repo.revisions!.head.oid!] : scope === 'staged' ? ['--cached', repo.revisions!.head.oid!] : scope === 'all' ? [repo.revisions!.mergeBase.oid!] : [];
    const oracle = direct(root, args); assert.equal(calls.filter(call => call.includes('--patch')).length, repo.snapshot.attempts); for (const call of calls.filter(call => call.includes('--patch'))) assert.deepEqual(call.slice(-args.length - 1), [...args, '--']);
    assert.deepEqual(comparison.files.map(fileKey).sort(), oracle.files.map(fileKey).sort());
    for (const file of comparison.files) await verify(root, file, file.patch!, scope === 'unstaged' || scope === 'all');
    if (scope === 'all') assert.equal(comparison.files.length, 0);
    assert.equal(comparison.patchCoverage?.totalBytes, oracle.bytes.length);
  }
}));

test('patch truncation retains machine metadata and snapshot retries discard unstable hunks', async () => fixture(async root => {
  await init(root); await writeFile(path.join(root, 'file.txt'), 'changed\n'); git(root, 'add', '.');
  const bounded = await collect(root, 'staged', { limits: { ...limits, maxPatchBytes: 20 } }); assert.equal(bounded.state, 'partial'); assert.equal(selected(bounded).files[0]?.added, 1); assert.equal(selected(bounded).patchCoverage?.truncated, true); assert.equal(selected(bounded).patchCoverage?.retainedBytes, 20); assert.ok(bounded.reasons.includes('PATCH_TRUNCATED'));
  let changes = 0; const mutate: GitRunner = async (...args) => { const result = await runGit(...args); if (args[1].includes('--patch')) { changes++; await writeFile(path.join(root, 'file.txt'), `mutation ${changes}\n`); } return result; };
  const inconsistent = await collect(root, 'unstaged', { runner: mutate }); assert.equal(inconsistent.state, 'failed'); assert.equal(inconsistent.snapshot.consistency, 'inconsistent'); assert.deepEqual(inconsistent.comparisons, []);
  let changed = false; const once: GitRunner = async (...args) => { const result = await runGit(...args); if (!changed && args[1].includes('--patch')) { changed = true; await writeFile(path.join(root, 'file.txt'), 'accepted final\n'); } return result; };
  const retried = await collect(root, 'unstaged', { runner: once }); assert.equal(retried.snapshot.attempts, 2); assert.equal(retried.state, 'complete', JSON.stringify(retried.diagnostics)); for (const file of selected(retried).files) await verify(root, file, file.patch!, true);
}));

test('untracked content is separate opt-in filesystem evidence, bounded and rechecked; secrets and links stay unread', async () => fixture(async root => {
  await init(root); await writeFile(path.join(root, 'new ไทย.txt'), 'filesystem\r\n'); await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 255, 3])); await writeFile(path.join(root, 'invalid.txt'), Buffer.from([255, 254])); await writeFile(path.join(root, 'large.txt'), 'x'.repeat(100)); await writeFile(path.join(root, '.env.private'), 'secret');
  await mkdir(path.join(root, 'outside')); await writeFile(path.join(root, 'outside', 'target.txt'), 'outside'); await symlink(path.join(root, 'outside'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const metadata = await collect(root, 'staged'); assert.equal(metadata.state, 'complete', JSON.stringify(metadata.diagnostics)); assert.ok(metadata.untracked.every(file => file.content === undefined)); assert.equal(selected(metadata).files.length, 0);
  const included = await collect(root, 'staged', { includeUntracked: true, limits: { ...limits, maxFileBytes: 30 } }); assert.equal(included.state, 'partial');
  const content = included.untracked.find(file => file.path === 'new ไทย.txt')!.content!; assert.equal(content.source, 'filesystem'); assert.equal(content.text, 'filesystem\r\n'); assert.equal(Buffer.from(content.bytes!, 'base64').toString(), content.text); assert.match(content.contentId!, /^[a-f0-9]{64}$/u); assert.equal(content.state, 'collected');
  assert.ok(included.untracked.find(file => file.path === 'binary.bin')!.content!.reason === 'UNTRACKED_BINARY'); assert.equal(included.untracked.find(file => file.path === 'invalid.txt')!.content!.reason, 'UNTRACKED_ENCODING'); assert.equal(included.untracked.find(file => file.path === 'large.txt')!.content!.reason, 'UNTRACKED_FILE_LIMIT'); assert.equal(included.excludedUntrackedCount, 1); assert.ok(included.untracked.every(file => file.path !== '.env.private'));
  for (const alias of included.untracked.filter(file => file.path === 'link' || file.path?.startsWith('link/'))) { assert.equal(alias.content?.state, 'omitted'); assert.equal(alias.content?.bytes, null); }
  let mutation = 0; const runner: GitRunner = async (...args) => { const result = await runGit(...args); if (args[1].includes('--patch')) await writeFile(path.join(root, 'new ไทย.txt'), `mutation ${++mutation}`); return result; };
  const inconsistent = await collect(root, 'staged', { includeUntracked: true, runner }); assert.equal(inconsistent.snapshot.consistency, 'inconsistent', JSON.stringify(inconsistent.diagnostics)); assert.deepEqual(inconsistent.untracked, []);
}));

test('unborn local scopes and missing bases remain independent; external diff and textconv cannot run', async () => fixture(async root => {
  await init(root, false); await writeFile(path.join(root, 'file.txt'), 'new\n'); git(root, 'add', '.');
  const unborn = await collect(root, 'staged', { base: null }); assert.equal(unborn.state, 'complete', JSON.stringify(unborn.diagnostics)); assert.equal(selected(unborn).before.kind, 'empty-tree'); assert.equal(selected(unborn).files[0]?.patch?.hunks[0]?.oldCount, 0);
  git(root, 'commit', '-m', 'seed'); git(root, 'branch', 'base'); await writeFile(path.join(root, '.gitattributes'), 'file.txt diff=sentinel\n'); git(root, 'add', '.gitattributes'); git(root, 'commit', '-m', 'attributes');
  git(root, 'config', 'diff.external', 'echo executed > external-ran'); git(root, 'config', 'diff.sentinel.command', 'echo executed > driver-ran'); git(root, 'config', 'diff.sentinel.textconv', 'echo executed > textconv-ran'); git(root, 'config', 'diff.suppressBlankEmpty', 'true'); git(root, 'config', 'diff.interHunkContext', '100'); await writeFile(path.join(root, 'file.txt'), 'edited\n');
  const local = await collect(root, 'unstaged', { base: 'missing' }); assert.equal(local.state, 'complete', JSON.stringify(local.diagnostics)); assert.ok(local.diagnostics.some(item => item.code === 'BASE_UNRESOLVED')); assert.equal(selected(local).files[0]?.patch?.hunks.length, 1);
  const unavailable = await collect(root, 'all', { base: 'missing' }); assert.equal(unavailable.state, 'partial'); assert.equal(selected(unavailable).state, 'unavailable');
  for (const name of ['external-ran', 'driver-ran', 'textconv-ran']) await assert.rejects(readFile(path.join(root, name)), { code: 'ENOENT' });
}));

test('diff CLI exposes help, one JSON document, useful human hunks, validation and independent repository failures', async () => fixture(async root => {
  const good = path.join(root, 'good ไทย'); const bad = path.join(root, 'bad'); await mkdir(good); await mkdir(bad); await init(good); await writeFile(path.join(good, 'file.txt'), 'changed\n'); await writeFile(path.join(bad, '.git'), 'gitdir: missing\n');
  const cli = (...args: string[]) => { const result = spawnSync(process.execPath, [entrypoint, 'diff', ...args], { encoding: 'utf8', shell: false, timeout: 90_000 }); assert.ifError(result.error); return result; };
  const help = cli('--help'); assert.equal(help.status, 0); assert.match(help.stdout, /--scope/); assert.match(help.stdout, /--include-untracked/);
  const json = cli('--root', root, '--base', 'base', '--scope', 'unstaged', '--json'); assert.equal(json.status, 1); assert.equal(json.stdout.trim().split('\n').length, 1); const report = JSON.parse(json.stdout) as { reportKind: string; repositories: RepositoryStatus[] }; assert.equal(report.reportKind, 'diff'); assert.equal(report.repositories.find(repo => repo.path === 'good ไทย')?.state, 'complete'); assert.equal(report.repositories.find(repo => repo.path === 'bad')?.state, 'failed'); assert.match(json.stderr, /warning \[REPOSITORY_INVALID\]/u);
  const human = cli('--root', good, '--base', 'base', '--scope', 'unstaged'); assert.equal(human.status, 0); assert.match(human.stdout, /@@ -1,1 \+1,1 @@/u); assert.match(human.stdout, /\+ "changed"/u);
  for (const args of [['--scope', 'invalid'], ['--scope', 'all', '--scope', 'branch'], ['--max-file-bytes', '0'], ['--max-patch-bytes', 'NaN']]) { const result = cli(...args, '--json'); assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).reportKind, 'error'); }
}));
