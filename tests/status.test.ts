import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, stat, utimes, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveLimits, type Config } from '../src/config/schema.js';
import { canonicalRoot, discover } from '../src/git/discovery.js';
import { collectRepository, type RepositoryStatus } from '../src/git/collector.js';
import { runGit, type GitRunner } from '../src/git/runner.js';
import { parseRaw, joinNumstat } from '../src/git/metadata.js';

const entrypoint = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const limits = resolveLimits(undefined);
const defaultConfig: Config = { configVersion: '1' };
function git(cwd: string, ...args: string[]): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, env, shell: false, timeout: 30_000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr.toString()); return result.stdout;
}
async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'difflearn-status-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function init(root: string, committed = true) {
  git(root, 'init', '-b', 'main'); git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'user.name', 'Synthetic'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(root, '.git', 'fixture-ignore'), ''); await writeFile(path.join(root, '.git', 'fixture-attributes'), '');
  git(root, 'config', 'core.excludesFile', '.git/fixture-ignore'); git(root, 'config', 'core.attributesFile', '.git/fixture-attributes');
  if (committed) { await writeFile(path.join(root, 'file.txt'), 'base\n'); git(root, 'add', '--', 'file.txt'); git(root, 'commit', '-m', 'base'); git(root, 'branch', 'base'); }
}
async function collect(root: string, base: string | null = 'base', config = defaultConfig, runner: GitRunner = runGit) {
  const actual = await canonicalRoot(root); const found = await discover(actual, config, limits);
  assert.equal(found.repositories[0]?.kind, 'worktree');
  return collectRepository(found.repositories[0]!, config, limits, { workspaceBytes: 0 }, base ?? undefined, undefined, runner);
}
function comparison(repo: RepositoryStatus, scope: string) { return repo.comparisons.find(item => item.scope === scope)!; }
async function physicalIndex(root: string) {
  const directory = path.join(root, '.git');
  const names = (await readdir(directory)).filter(name => name === 'index' || name.startsWith('sharedindex.')).sort();
  return Promise.all(names.map(async name => {
    const filename = path.join(directory, name); const info = await stat(filename, { bigint: true });
    return { name, bytes: await readFile(filename), dev: info.dev, ino: info.ino, size: info.size, mode: info.mode, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
  }));
}
function assertGitPaths(root: string, repo: RepositoryStatus) {
  const h = repo.revisions!.head.oid; const m = repo.revisions!.mergeBase.oid;
  for (const scope of ['branch', 'staged', 'unstaged', 'all']) {
    const args = scope === 'branch' ? [m!, h!] : scope === 'staged' ? ['--cached', ...h ? [h] : []] : scope === 'all' ? [m!] : [];
    const records = git(root, 'diff', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '--ita-visible-in-index', '--name-status', '-z', ...args, '--').toString().split('\0');
    const expected: { status: string; original: string; destination: string }[] = [];
    for (let index = 0; index < records.length - 1; index++) { const status = records[index]!; const first = records[++index]!; const second = status.startsWith('R') ? records[++index]! : first; expected.push({ status: status[0]!, original: first, destination: second }); }
    const actual = comparison(repo, scope).files.map(file => ({ status: file.status, original: file.originalPath!, destination: file.destinationPath! }));
    assert.deepEqual(actual.sort((a, b) => a.destination.localeCompare(b.destination)), expected.sort((a, b) => a.destination.localeCompare(b.destination)), scope);
  }
}

test('four direct scopes match Git; clean worktree still reports committed branch changes', async () => fixture(async root => {
  await init(root); await writeFile(path.join(root, 'file.txt'), 'committed\n'); git(root, 'commit', '-am', 'feature');
  const clean = await collect(root); assert.equal(clean.state, 'complete', JSON.stringify(clean.diagnostics)); assert.equal(clean.workingTree?.clean, true); assert.equal(comparison(clean, 'branch').files.length, 1); assert.equal(comparison(clean, 'staged').files.length, 0); assertGitPaths(root, clean);
  assert.equal(clean.revisions?.head.oid, git(root, 'rev-parse', 'HEAD').toString().trim()); assert.equal(clean.revisions?.base.oid, git(root, 'rev-parse', 'base').toString().trim()); assert.equal(clean.revisions?.mergeBase.oid, git(root, 'merge-base', 'base', 'HEAD').toString().trim());
  await writeFile(path.join(root, 'file.txt'), 'staged\n'); git(root, 'add', '--', 'file.txt'); await writeFile(path.join(root, 'file.txt'), 'base\n');
  const indexBefore = await physicalIndex(root); const repo = await collect(root);
  assert.deepEqual(await physicalIndex(root), indexBefore, 'collection preserves index bytes and physical metadata');
  assert.equal(repo.state, 'complete', JSON.stringify(repo.diagnostics)); assertGitPaths(root, repo);
  assert.equal(comparison(repo, 'all').files.length, 0, 'committed and local edits cancel in net comparison'); assert.equal(comparison(repo, 'staged').files[0]?.added, 1); assert.equal(comparison(repo, 'unstaged').files[0]?.deleted, 1); assert.equal(repo.workingTree?.entries[0]?.xy, 'MM');
  const repeated = await collect(root); assert.equal(repeated.snapshot.snapshotId, repo.snapshot.snapshotId);
}));

test('staged/unstaged cancellation uses direct all comparison', async () => fixture(async root => {
  await init(root); await writeFile(path.join(root, 'file.txt'), 'changed\n'); git(root, 'add', '--', 'file.txt'); await writeFile(path.join(root, 'file.txt'), 'base\n');
  await utimes(path.join(root, 'file.txt'), new Date(0), new Date(0));
  const indexBefore = await physicalIndex(root); const repo = await collect(root);
  assert.equal(repo.state, 'complete', JSON.stringify(repo.diagnostics)); assert.equal(repo.snapshot.attempts, 1);
  assert.deepEqual(await physicalIndex(root), indexBefore);
  assertGitPaths(root, repo); assert.equal(comparison(repo, 'all').files.length, 0); assert.equal(comparison(repo, 'staged').files.length, 1); assert.equal(comparison(repo, 'unstaged').files.length, 1);
}));

test('renames retain both paths, binary numstat is null, and untracked metadata stays separate', async () => fixture(async root => {
  await init(root); await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2])); git(root, 'add', '--', 'binary.bin'); git(root, 'commit', '-m', 'binary'); git(root, 'branch', '-f', 'base', 'HEAD');
  const untrackedName = process.platform === 'win32' ? '-untracked ไทย.txt' : '-untracked\tไทย.txt';
  await rename(path.join(root, 'file.txt'), path.join(root, 'new ไทย name.txt')); git(root, 'add', '-A'); await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 3, 4])); git(root, 'add', '--', 'binary.bin'); await writeFile(path.join(root, untrackedName), 'local only\n'); await writeFile(path.join(root, '.env.private'), 'fixture\n');
  const repo = await collect(root); assert.equal(repo.state, 'complete', JSON.stringify(repo.diagnostics)); assertGitPaths(root, repo);
  const renameFact = comparison(repo, 'staged').files.find(file => file.status === 'R')!; assert.equal(renameFact.originalPath, 'file.txt'); assert.equal(renameFact.destinationPath, 'new ไทย name.txt'); assert.equal(renameFact.similarity, 100);
  const binary = comparison(repo, 'staged').files.find(file => file.destinationPath === 'binary.bin')!; assert.equal(binary.binary, true); assert.equal(binary.added, null); assert.equal(binary.deleted, null); assert.match(git(root, 'diff', '--cached', '--numstat', '-z').toString(), /-\t-\tbinary.bin\0/u);
  assert.equal(repo.untracked.length, 1); assert.equal(repo.untracked[0]?.path, untrackedName); assert.equal(repo.untracked[0]?.contentPolicy, 'metadata-only'); assert.equal(repo.excludedUntrackedCount, 1);
}));

test('staged deletion plus untracked recreation remains deletion and separate untracked record', async () => fixture(async root => {
  await init(root); git(root, 'rm', '--', 'file.txt'); await writeFile(path.join(root, 'file.txt'), 'recreated\n'); const repo = await collect(root);
  assertGitPaths(root, repo); assert.equal(comparison(repo, 'all').files[0]?.status, 'D'); assert.equal(repo.untracked[0]?.path, 'file.txt');
}));

test('base precedence rejects invalid higher choices and never guesses branch names', async () => fixture(async root => {
  await init(root); git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const config: Config = { configVersion: '1', base: 'missing-workspace', repositories: [{ path: '.', base: 'base' }] };
  const configured = await collect(root, null, config); assert.equal(configured.revisions?.base.resolutionSource, 'repository-config');
  const cli = await collect(root, 'HEAD', config); assert.equal(cli.revisions?.base.resolutionSource, 'cli');
  const missing = await collect(root, 'no-such-ref', config); assert.equal(missing.revisions?.base.reason, 'BASE_UNRESOLVED'); assert.equal(comparison(missing, 'branch').state, 'unavailable'); assert.equal(comparison(missing, 'staged').state, 'complete');
  const automatic = await collect(root, null); assert.equal(automatic.revisions?.base.resolutionSource, 'origin-head'); assert.equal(automatic.revisions?.base.remoteFreshness, 'not-verified');
  git(root, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'); const noGuess = await collect(root, null); assert.equal(noGuess.revisions?.base.reason, 'BASE_REQUIRED');
  git(root, 'update-ref', 'refs/remotes/other/main', 'HEAD'); git(root, 'symbolic-ref', 'refs/remotes/other/HEAD', 'refs/remotes/other/main'); assert.equal((await collect(root, null)).revisions?.base.resolutionSource, 'remote-head');
  git(root, 'symbolic-ref', 'refs/remotes/broken/HEAD', 'refs/remotes/broken/missing'); assert.equal((await collect(root, null)).revisions?.base.reason, 'BASE_AMBIGUOUS'); git(root, 'symbolic-ref', '--delete', 'refs/remotes/broken/HEAD');
  git(root, 'update-ref', 'refs/remotes/third/main', 'HEAD'); git(root, 'symbolic-ref', 'refs/remotes/third/HEAD', 'refs/remotes/third/main'); assert.equal((await collect(root, null)).revisions?.base.reason, 'BASE_AMBIGUOUS');
  git(root, 'tag', 'base'); assert.equal((await collect(root, 'base')).revisions?.base.reason, 'BASE_UNRESOLVED'); assert.equal((await collect(root, 'refs/heads/base')).revisions?.base.reason, null);
}));

test('detached and unborn HEAD are explicit; unborn local comparisons remain valid', async () => fixture(async root => {
  const detached = path.join(root, 'detached'); const unborn = path.join(root, 'unborn'); await mkdir(detached); await mkdir(unborn); await init(detached); git(detached, 'checkout', '--detach', 'HEAD');
  const repo = await collect(detached); assert.equal(repo.revisions?.head.state, 'detached'); assert.equal(repo.revisions?.head.branch, null); assertGitPaths(detached, repo);
  await init(unborn, false); await writeFile(path.join(unborn, 'new.txt'), 'new\n'); git(unborn, 'add', '--', 'new.txt'); await writeFile(path.join(unborn, 'new.txt'), 'edited\n');
  const fresh = await collect(unborn, null); assert.equal(fresh.revisions?.head.state, 'unborn'); assert.equal(fresh.revisions?.head.oid, null); assert.equal(comparison(fresh, 'branch').reasons[0], 'UNBORN_HEAD'); assert.equal(comparison(fresh, 'staged').before.kind, 'empty-tree'); assert.equal(comparison(fresh, 'staged').files[0]?.status, 'A'); assert.equal(comparison(fresh, 'unstaged').files[0]?.status, 'M');
}));

test('unrelated histories do not invent a merge-base', async () => fixture(async root => {
  await init(root); git(root, 'checkout', '--orphan', 'other'); git(root, 'rm', '-rf', '.'); await writeFile(path.join(root, 'other.txt'), 'other\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'unrelated');
  const repo = await collect(root); assert.equal(repo.revisions?.mergeBase.reason, 'NO_MERGE_BASE'); assert.equal(repo.revisions?.mergeBase.oid, null); assert.equal(comparison(repo, 'staged').state, 'complete');
}));

test('conflicts expose stage OIDs and XY, keep unaffected changes, omit local conflict diffs', async () => fixture(async root => {
  await init(root); git(root, 'checkout', '-b', 'feature'); await writeFile(path.join(root, 'file.txt'), 'ours\n'); git(root, 'commit', '-am', 'ours'); git(root, 'checkout', 'main'); await writeFile(path.join(root, 'file.txt'), 'theirs\n'); git(root, 'commit', '-am', 'theirs'); git(root, 'checkout', 'feature');
  const merge = spawnSync('git', ['merge', 'main'], { cwd: root, encoding: 'utf8', shell: false }); assert.equal(merge.status, 1);
  await writeFile(path.join(root, 'safe.txt'), 'safe\n'); git(root, 'add', '--', 'safe.txt'); const repo = await collect(root);
  assert.equal(repo.conflicts.length, 1); assert.equal(repo.conflicts[0]?.xy, 'UU');
  const stageLines = git(root, 'ls-files', '--stage', '-z').toString().split('\0'); for (const [index, stage] of ['base', 'ours', 'theirs'].entries()) { const fact = repo.conflicts[0]!.stages[stage as 'base' | 'ours' | 'theirs']!; assert.ok(stageLines.includes(`100644 ${fact.oid} ${index + 1}\tfile.txt`)); }
  assert.equal(comparison(repo, 'branch').state, 'complete'); for (const scope of ['staged', 'unstaged', 'all']) { assert.equal(comparison(repo, scope).state, 'partial', JSON.stringify(repo.diagnostics)); assert.ok(!comparison(repo, scope).files.some(file => file.destinationPath === 'file.txt')); }
  assert.ok(comparison(repo, 'staged').files.some(file => file.destinationPath === 'safe.txt'));
}));

test('snapshot retries once and discards unstable comparison data', async () => fixture(async root => {
  await init(root); let mutations = 0;
  const mutate: GitRunner = async (...args) => { const result = await runGit(...args); if (args[1].includes('--numstat') && args[1].includes('--attr-source=' + git(root, 'rev-parse', 'HEAD').toString().trim())) { mutations++; await writeFile(path.join(root, 'file.txt'), `mutation ${mutations}\n`); } return result; };
  const unstable = await collect(root, 'base', defaultConfig, mutate); assert.equal(unstable.state, 'failed'); assert.equal(unstable.snapshot.attempts, 2); assert.equal(unstable.snapshot.consistency, 'inconsistent'); assert.deepEqual(unstable.comparisons, []); assert.equal(unstable.revisions, null); assert.ok(unstable.reasons.includes('SNAPSHOT_INCONSISTENT'));
  let changed = false; const once: GitRunner = async (...args) => { const result = await runGit(...args); if (!changed && args[1].includes('--numstat')) { changed = true; await writeFile(path.join(root, 'file.txt'), 'stable final\n'); } return result; };
  const retried = await collect(root, 'base', defaultConfig, once); assert.equal(retried.snapshot.attempts, 2); assert.equal(retried.snapshot.consistency, 'verified-optimistic'); assertGitPaths(root, retried);
}));

test('active filters and fsmonitor are disabled; flagged working coverage is unavailable', async () => fixture(async root => {
  await init(root); await writeFile(path.join(root, '.gitattributes'), 'file.txt filter=sentinel\n');
  git(root, 'config', 'filter.sentinel.clean', 'echo ran > filter-ran.txt'); git(root, 'config', 'filter.sentinel.process', 'echo ran > process-ran.txt'); git(root, 'config', 'filter.sentinel.required', 'true'); git(root, 'config', 'core.fsmonitor', 'echo ran > monitor-ran.txt');
  const repo = await collect(root); assert.ok(repo.reasons.includes('ACTIVE_FILTER')); assert.equal(repo.workingTree?.available, false); assert.equal(comparison(repo, 'branch').state, 'complete'); assert.equal(comparison(repo, 'staged').state, 'complete'); assert.equal(comparison(repo, 'unstaged').state, 'unavailable');
  for (const name of ['filter-ran.txt', 'process-ran.txt', 'monitor-ran.txt']) await assert.rejects(readFile(path.join(root, name)), { code: 'ENOENT' });
}));

test('skip-worktree and symlink directory boundaries withhold working commands', async () => fixture(async root => {
  await init(root); git(root, 'update-index', '--skip-worktree', 'file.txt'); const sparse = await collect(root); assert.ok(sparse.reasons.includes('SKIP_WORKTREE')); assert.equal(comparison(sparse, 'staged').state, 'complete');
  git(root, 'update-index', '--no-skip-worktree', 'file.txt'); await mkdir(path.join(root, 'dir')); await writeFile(path.join(root, 'dir', 'tracked.txt'), 'tracked\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'directory');
  const outside = path.join(root, 'outside'); await rename(path.join(root, 'dir'), outside); await symlink(outside, path.join(root, 'dir'), process.platform === 'win32' ? 'junction' : 'dir'); const commands: string[][] = [];
  const recording: GitRunner = async (...args) => { commands.push(args[1]); return runGit(...args); }; const bounded = await collect(root, 'base', defaultConfig, recording); assert.ok(bounded.reasons.includes('WORKTREE_SYMLINK_BOUNDARY')); assert.equal(comparison(bounded, 'branch').state, 'complete'); assert.ok(!commands.some(args => args.includes('status')));
}));

test('status CLI preserves successful repositories alongside failures and emits one document', async () => fixture(async root => {
  const good = path.join(root, 'good ไทย'); const bad = path.join(root, 'bad'); await mkdir(good); await mkdir(bad); await init(good); await writeFile(path.join(bad, '.git'), 'gitdir: nonexistent\n');
  const result = spawnSync(process.execPath, [entrypoint, 'status', '--root', root, '--base', 'base', '--json'], { encoding: 'utf8', shell: false, timeout: 60_000 }); assert.ifError(result.error); assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout) as { reportKind: string; repositories: RepositoryStatus[]; completeness: { state: string } }; assert.equal(result.stdout.trim().split('\n').length, 1); assert.equal(report.reportKind, 'status'); assert.equal(report.repositories.find(repo => repo.path === 'good ไทย')?.state, 'complete'); assert.equal(report.repositories.find(repo => repo.path === 'bad')?.state, 'failed'); assert.match(result.stderr, /warning \[REPOSITORY_INVALID\]/u);
  const human = spawnSync(process.execPath, [entrypoint, 'status', '--root', good, '--base', 'base'], { encoding: 'utf8', shell: false, timeout: 60_000 }); assert.equal(human.status, 0); assert.match(human.stdout, /Working tree: clean/u); assert.match(human.stdout, /Committed branch changes/u);
  const invalid = spawnSync(process.execPath, [entrypoint, 'status', '--scope', 'all', '--json'], { encoding: 'utf8', shell: false }); assert.equal(invalid.status, 2); assert.equal(JSON.parse(invalid.stdout).reportKind, 'error');
}));

test('truncated raw/numstat and unsupported path encoding remain observable', () => {
  assert.throws(() => parseRaw(Buffer.from(':100644 100644 a b M')), /truncated/u);
  const raw = Buffer.concat([Buffer.from(`:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0`), Buffer.from([0xff, 0])]); const files = parseRaw(raw); assert.equal(files[0]?.destinationPath, null); assert.equal(files[0]?.destinationPathBytes, '/w==');
  assert.throws(() => joinNumstat(files, Buffer.from('1\t1\tdifferent\0')), /machine format/u);
});

test('intent-to-add follows explicit visible-index policy and mode changes preserve metadata', async () => fixture(async root => {
  await init(root); await writeFile(path.join(root, 'intent.txt'), 'worktree\n'); git(root, 'add', '-N', '--', 'intent.txt'); git(root, 'update-index', '--chmod=+x', 'file.txt');
  const indexBefore = await physicalIndex(root); const repo = await collect(root); assert.equal(repo.state, 'complete', JSON.stringify(repo.diagnostics));
  assert.deepEqual(await physicalIndex(root), indexBefore);
  assert.equal(repo.capabilities?.intentToAddPolicy, 'experimental-visible-in-index'); assert.equal(repo.capabilities?.intentToAddPaths[0]?.path, 'intent.txt');
  const addition = comparison(repo, 'staged').files.find(file => file.destinationPath === 'intent.txt')!; assert.equal(addition.status, 'A'); assert.equal(addition.added, 0);
  const executable = comparison(repo, 'staged').files.find(file => file.destinationPath === 'file.txt')!; assert.equal(executable.oldMode, '100644'); assert.equal(executable.newMode, '100755'); assert.equal(executable.added, 0);
  git(root, 'update-index', '--split-index'); const patchIndexBefore = await physicalIndex(root);
  const found = await discover(await canonicalRoot(root), defaultConfig, limits);
  for (const scope of ['branch', 'staged', 'unstaged', 'all'] as const) {
    const patched = await collectRepository(found.repositories[0]!, defaultConfig, limits, { workspaceBytes: 0 }, 'base', undefined, runGit, { scope, includeUntracked: false });
    assert.equal(patched.state, 'complete', JSON.stringify(patched.diagnostics)); assert.equal(patched.snapshot.attempts, 1);
    const files = comparison(patched, scope).files;
    assert.deepEqual(files.map(({ patch, ...file }) => file), comparison(repo, scope).files);
    assert.ok(files.every(file => file.patch?.state === 'complete'));
    if (scope === 'staged') {
      assert.equal(files.find(file => file.destinationPath === 'intent.txt')!.patch!.hunks.length, 0);
      assert.equal(files.find(file => file.destinationPath === 'file.txt')!.patch!.hunks.length, 0);
    }
    assert.deepEqual(await physicalIndex(root), patchIndexBefore);
  }
  assertGitPaths(root, repo);
}));

test('stat-only and attribute-normalized changes preserve ordinary and split indexes across metadata and patches', async () => fixture(async root => {
  await init(root); await writeFile(path.join(root, '.gitattributes'), 'file.txt text eol=crlf\n'); git(root, 'add', '.gitattributes'); git(root, 'commit', '-m', 'attributes'); git(root, 'branch', '-f', 'base', 'HEAD');
  // Same normalized content, deliberately stale stat data. No timing race needed.
  await writeFile(path.join(root, 'file.txt'), 'base\r\n'); await utimes(path.join(root, 'file.txt'), new Date(0), new Date(0));
  for (const split of [false, true]) {
    if (split) git(root, 'update-index', '--split-index');
    for (const refresh of ['false', 'true']) {
      git(root, 'config', 'diff.autoRefreshIndex', refresh);
      const indexBefore = await physicalIndex(root); const repo = await collect(root);
      assert.equal(repo.state, 'complete', JSON.stringify(repo.diagnostics)); assert.equal(repo.snapshot.attempts, 1);
      assert.ok(repo.comparisons.every(item => item.files.length === 0));
      assert.deepEqual(await physicalIndex(root), indexBefore);
      const found = await discover(await canonicalRoot(root), defaultConfig, limits);
      for (const scope of ['branch', 'staged', 'unstaged', 'all'] as const) {
        const patched = await collectRepository(found.repositories[0]!, defaultConfig, limits, { workspaceBytes: 0 }, 'base', undefined, runGit, { scope, includeUntracked: false });
        assert.equal(patched.state, 'complete', JSON.stringify(patched.diagnostics)); assert.equal(patched.snapshot.attempts, 1);
        assert.equal(comparison(patched, scope).files.length, 0); assert.equal(comparison(patched, scope).patchCoverage?.totalBytes, 0);
        assert.deepEqual(await physicalIndex(root), indexBefore, `${scope}, split=${split}, refresh=${refresh}`);
      }
    }
  }
}));

test('byte-identical physical index replacement remains a real snapshot mutation', async () => fixture(async root => {
  await init(root); let replacements = 0;
  const replaceIndex: GitRunner = async (...args) => {
    const result = await runGit(...args);
    if (args[1].includes('--numstat')) {
      const filename = path.join(root, '.git', 'index'); const temporary = path.join(root, '.git', `replacement-${++replacements}`);
      await writeFile(temporary, await readFile(filename)); await rename(temporary, filename);
    }
    return result;
  };
  const indexBefore = (await physicalIndex(root))[0]!.bytes;
  const repo = await collect(root, 'base', defaultConfig, replaceIndex);
  assert.deepEqual((await physicalIndex(root))[0]!.bytes, indexBefore);
  assert.equal(repo.state, 'failed'); assert.equal(repo.snapshot.attempts, 2); assert.equal(repo.snapshot.consistency, 'inconsistent');
  assert.ok(repo.reasons.includes('SNAPSHOT_INCONSISTENT')); assert.deepEqual(repo.comparisons, []);
}));

test('multiple merge-bases are exposed instead of selecting an arbitrary ancestor', async () => fixture(async root => {
  await init(root); const first = git(root, 'rev-parse', 'HEAD').toString().trim(); const tree = git(root, 'rev-parse', 'HEAD^{tree}').toString().trim();
  const a = git(root, 'commit-tree', tree, '-p', first, '-m', 'a').toString().trim(); const b = git(root, 'commit-tree', tree, '-p', first, '-m', 'b').toString().trim();
  const left = git(root, 'commit-tree', tree, '-p', a, '-p', b, '-m', 'left').toString().trim(); const right = git(root, 'commit-tree', tree, '-p', b, '-p', a, '-m', 'right').toString().trim();
  git(root, 'update-ref', 'refs/heads/main', left); git(root, 'update-ref', 'refs/heads/base', right); const repo = await collect(root);
  assert.equal(repo.revisions?.mergeBase.reason, 'MULTIPLE_MERGE_BASES'); assert.deepEqual(repo.revisions?.mergeBase.candidates, git(root, 'merge-base', '--all', left, right).toString().trim().split('\n').sort()); assert.equal(comparison(repo, 'branch').state, 'unavailable');
}));

test('snapshot byte limits and failed comparison commands cannot look clean', async () => fixture(async root => {
  await init(root); const actual = await canonicalRoot(root); const discovered = await discover(actual, defaultConfig, limits); const repository = discovered.repositories[0]!;
  const bounded = await collectRepository(repository, defaultConfig, { ...limits, maxSnapshotBytes: 1 }, { workspaceBytes: 0 }, 'base'); assert.equal(bounded.state, 'failed'); assert.equal(bounded.snapshot.consistency, 'unverified'); assert.ok(bounded.reasons.includes('SNAPSHOT_BYTE_LIMIT'));
  const failed: GitRunner = async (...args) => args[1].includes('diff') && args[1].includes('--cached') ? { code: 128, stdout: Buffer.alloc(0), stderr: 'synthetic index object failure' } : runGit(...args);
  const partial = await collect(root, 'base', defaultConfig, failed); assert.equal(partial.state, 'partial'); assert.equal(comparison(partial, 'branch').state, 'complete'); assert.equal(comparison(partial, 'staged').state, 'unavailable'); assert.match(partial.diagnostics.find(item => item.scope === 'staged')!.message, /synthetic index object failure/u);
}));

test('gitlinks keep parent metadata and dirty indicators; submodule filters never execute', async () => fixture(async root => {
  await init(root); const child = path.join(root, 'module'); await mkdir(child); await init(child); git(root, 'add', '--', 'module'); git(root, 'commit', '-m', 'gitlink'); git(root, 'branch', '-f', 'base', 'HEAD');
  await writeFile(path.join(child, 'file.txt'), 'child dirty\n'); const repo = await collect(root); assert.equal(repo.state, 'complete', JSON.stringify(repo.diagnostics)); assert.ok(repo.workingTree?.entries.find(entry => entry.path === 'module')?.submodule.startsWith('S'));
  const moduleChange = comparison(repo, 'all').files.find(file => file.destinationPath === 'module')!; assert.equal(moduleChange.kind, 'gitlink'); assert.equal(moduleChange.added, null); assert.equal(moduleChange.deleted, null);
  git(child, 'config', 'filter.sentinel.clean', 'echo ran > child-filter-ran.txt'); await writeFile(path.join(child, '.gitattributes'), 'file.txt filter=sentinel\n'); const guarded = await collect(root); assert.ok(guarded.reasons.includes('SUBMODULE_ACTIVE_FILTER')); assert.equal(comparison(guarded, 'branch').state, 'complete'); await assert.rejects(readFile(path.join(child, 'child-filter-ran.txt')), { code: 'ENOENT' });
}));

test('snapshot identity excludes absolute locators and stat-cache guards', async () => fixture(async root => {
  const before = path.join(root, 'before'); const after = path.join(root, 'after'); await mkdir(before); await init(before); const first = await collect(before);
  await rename(before, after); const second = await collect(after); assert.equal(first.state, 'complete', JSON.stringify(first.diagnostics)); assert.equal(second.state, 'complete', JSON.stringify(second.diagnostics)); assert.equal(first.snapshot.snapshotId, second.snapshot.snapshotId); assert.equal(first.comparisons[0]?.comparisonId, second.comparisons[0]?.comparisonId);
}));

test('bundle budget keeps successful prefix and explicit omitted repository outcomes', async () => fixture(async root => {
  for (const name of ['a', 'b', 'c']) { const directory = path.join(root, name); await mkdir(directory); await init(directory); }
  const large = path.join(root, 'b'); for (let index = 0; index < 90; index++) await writeFile(path.join(large, `${index.toString().padStart(3, '0')}-${'long-name-'.repeat(8)}.txt`), 'new\n'); git(large, 'add', '.');
  await writeFile(path.join(root, '.difflearn.json'), JSON.stringify({ configVersion: '1', limits: { maxBundleBytes: 65_536 } }));
  const result = spawnSync(process.execPath, [entrypoint, 'status', '--root', root, '--base', 'base', '--json'], { encoding: 'utf8', shell: false, timeout: 90_000 }); assert.ifError(result.error); assert.equal(result.status, 1); assert.ok(Buffer.byteLength(result.stdout) <= 65_536);
  const report = JSON.parse(result.stdout) as { repositories: RepositoryStatus[] }; assert.equal(report.repositories[0]?.state, 'complete'); assert.ok(report.repositories[1]?.reasons.includes('BUNDLE_LIMIT')); assert.ok(report.repositories[2]?.reasons.includes('BUNDLE_LIMIT')); assert.equal(report.repositories[2]?.snapshot.attempts, 0);
}));

test('unborn unsafe attribute boundary withholds staged metadata and bounds Git stdin', async () => fixture(async root => {
  await init(root, false); await mkdir(path.join(root, 'dir')); await writeFile(path.join(root, 'dir', 'file.txt'), 'new\n'); git(root, 'add', '--', 'dir/file.txt');
  const destination = path.join(root, 'moved'); await rename(path.join(root, 'dir'), destination); await symlink(destination, path.join(root, 'dir'), process.platform === 'win32' ? 'junction' : 'dir');
  const repo = await collect(root, null); assert.equal(comparison(repo, 'staged').state, 'unavailable'); assert.ok(comparison(repo, 'staged').reasons.includes('UNBORN_ATTRIBUTE_BOUNDARY'));
  await assert.rejects(runGit(root, ['--version'], { ...limits, maxMetadataBytes: 1 }, undefined, Buffer.from('xx')), /input exceeded/u);
}));

