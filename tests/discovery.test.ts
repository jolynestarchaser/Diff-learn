import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, readFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { canonicalRoot, discover, type DiscoveryIO } from '../src/git/discovery.js';
import { runGit } from '../src/git/runner.js';
import { defaultLimits } from '../src/config/schema.js';

const cli = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', ...args], { cwd, env, encoding: 'utf8', shell: false });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout;
}
async function repo(root: string, name: string, bare = false) {
  const directory = path.join(root, name); await mkdir(directory, { recursive: true });
  git(directory, 'init', ...(bare ? ['--bare'] : [])); return directory;
}
function scan(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, 'scan', '--root', root, ...args, '--json'], { encoding: 'utf8', shell: false, timeout: 30_000 });
  assert.ifError(result.error);
  const report = JSON.parse(result.stdout) as { reportKind: string; repositories: Awaited<ReturnType<typeof discover>>['repositories']; discovery: Awaited<ReturnType<typeof discover>>['discovery']; completeness: { state: string }; diagnostics: { code: string }[]; request: { limits: typeof defaultLimits } };
  return { ...result, report };
}
async function fixture(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'difflearn-fixture-'));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('root, siblings, nested repositories and Thai/space paths are verified and stable', async () => fixture(async root => {
  await repo(root, '.'); await repo(root, 'service a'); await repo(root, 'ไทย/nested');
  await writeFile(path.join(root, 'synthetic.txt'), 'synthetic staged content\n'); git(root, 'add', 'synthetic.txt');
  const before = await readFile(path.join(root, '.git', 'HEAD'));
  const indexBefore = await readFile(path.join(root, '.git', 'index'));
  const first = scan(root); const second = scan(root, '--lang', 'th');
  assert.equal(first.status, 0, first.stderr); assert.equal(first.stderr, '');
  assert.deepEqual(first.report.repositories.map(item => item.path), ['.', 'service a', 'ไทย/nested']);
  assert.deepEqual(first.report.repositories.map(item => item.repositoryId), second.report.repositories.map(item => item.repositoryId));
  assert.deepEqual(await readFile(path.join(root, '.git', 'HEAD')), before);
  assert.deepEqual(await readFile(path.join(root, '.git', 'index')), indexBefore);
  assert.equal(first.report.completeness.state, 'complete');
}));

test('config overrides bases without becoming an allowlist; CLI overrides limits', async () => fixture(async root => {
  await repo(root, 'a'); await repo(root, 'b');
  await writeFile(path.join(root, '.difflearn.json'), JSON.stringify({ configVersion: '1', base: 'origin/default', repositories: [{ path: 'a', key: 'logical-a', base: 'origin/special' }], limits: { maxDepth: 0 } }));
  const result = scan(root, '--max-depth', '8');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.repositories.map(item => item.key), ['b', 'logical-a']);
  const a = result.report.repositories.find(item => item.path === 'a')!;
  assert.equal(a.baseConfiguration.input, 'origin/special'); assert.equal(a.baseConfiguration.source, 'repository-config');
  assert.equal(result.report.repositories.find(item => item.path === 'b')!.baseConfiguration.input, 'origin/default');
  assert.equal(result.report.request.limits.maxDepth, 8);
  const selected = scan(root, '--max-depth', '8', '--repo', 'a');
  assert.equal(selected.report.repositories.length, 1);
}));

test('linked worktrees sharing a common directory keep distinct IDs', async () => fixture(async root => {
  const main = await repo(root, 'main'); git(main, 'commit', '--allow-empty', '-m', 'synthetic');
  git(main, 'worktree', 'add', '-b', 'fixture-worktree', path.join(root, 'linked'));
  const result = scan(root);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.report.repositories.length, 2);
  const [linked, original] = result.report.repositories;
  assert.equal(linked!.commonDirectory, original!.commonDirectory);
  assert.notEqual(linked!.repositoryId, original!.repositoryId); assert.equal(linked!.linkedWorktree, true);
}));

test('dependency/output/config exclusions are literal and additive', async () => fixture(async root => {
  for (const name of ['node_modules/hidden', 'dist/hidden', 'archive/hidden', 'custom/hidden', 'visible']) await repo(root, name);
  await writeFile(path.join(root, '.difflearn.json'), JSON.stringify({ configVersion: '1', excludePaths: ['archive'], excludeDirectories: ['custom'] }));
  const result = scan(root); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.repositories.map(item => item.path), ['visible']);
  assert.ok(result.report.discovery.skipped.length >= 4);
}));

test('bare repositories and invalid gitfiles stay visible as partial results', async () => fixture(async root => {
  await repo(root, 'good'); await repo(root, 'bare', true);
  const invalid = path.join(root, 'broken'); await mkdir(invalid); await writeFile(path.join(invalid, '.git'), 'gitdir: missing\n');
  const result = scan(root); assert.equal(result.status, 1);
  assert.equal(result.report.completeness.state, 'partial'); assert.ok(result.stderr.includes('REPOSITORY_INVALID'));
  assert.equal(result.report.repositories.find(item => item.path === 'bare')!.kind, 'unsupported-bare');
  assert.equal(result.report.repositories.find(item => item.path === 'broken')!.kind, 'failed');
}));

test('junction/symlink aliases and escapes are skipped; an explicit alias root canonicalizes', async () => fixture(async root => {
  await fixture(async outside => {
    await repo(outside, 'secret'); const main = await repo(root, 'main');
    await symlink(outside, path.join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(main, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = scan(root); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.report.repositories.map(item => item.path), ['main']);
    assert.equal(result.report.discovery.skipped.filter(item => item.reason === 'symlink').length, 2);
    const alias = scan(path.join(root, 'alias')); const direct = scan(main);
    assert.equal(alias.status, 0, alias.stderr); assert.equal(alias.report.repositories[0]!.repositoryId, direct.report.repositories[0]!.repositoryId);
  });
}));

test('submodules at nested index paths are boundaries, even without .gitmodules', async () => fixture(async root => {
  const parent = await repo(root, 'parent'); const child = await repo(root, 'parent/deps/child');
  git(child, 'commit', '--allow-empty', '-m', 'synthetic child'); git(parent, 'add', 'deps/child');
  const result = scan(root); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.repositories.map(item => item.path), ['parent']);
  assert.deepEqual(result.report.repositories[0]!.submodules, [{ path: 'deps/child', childContent: 'not-collected' }]);
  assert.ok(result.report.discovery.skipped.some(item => item.path === 'parent/deps/child' && item.reason === 'submodule'));
  assert.equal(scan(child).report.repositories[0]!.path, '.');
}));

test('limits and unreadable subtrees preserve peers with explicit incomplete coverage', async () => fixture(async root => {
  await repo(root, 'a'); await repo(root, 'b');
  const limited = scan(root, '--max-depth', '0'); assert.equal(limited.status, 1);
  assert.ok(limited.report.diagnostics.some(item => item.code === 'DEPTH_LIMIT'));
  const actual = await realpath(root);
  const io: DiscoveryIO = { git: runGit, readDirectory: async directory => {
    if (directory === path.join(actual, 'b')) throw Object.assign(new Error('synthetic denial'), { code: 'EACCES' });
    if (directory === actual) return [{ name: 'a', type: 'directory' }, { name: 'b', type: 'directory' }];
    return [{ name: '.git', type: 'directory' }];
  } };
  const result = await discover(actual, { configVersion: '1' }, defaultLimits, [], io);
  assert.equal(result.completeness.state, 'partial'); assert.deepEqual(result.repositories.map(item => item.path), ['a']);
  assert.deepEqual(result.discovery.incompleteSubtrees, ['b']);
}));

test('errors have JSON envelopes and exit 1/2, empty workspace is complete', async () => fixture(async root => {
  assert.equal(scan(root).status, 0);
  assert.equal(scan(path.join(root, 'missing')).status, 1);
  assert.equal(scan(root, '--config', path.join(root, 'missing.json')).status, 2);
  assert.equal(scan(root, '--repo', 'missing').status, 2);
  assert.equal(scan(root, '--concurrency', '0').status, 2);
  assert.equal(scan(root, '--root', root).status, 2);
  await writeFile(path.join(root, '.difflearn.json'), '{"configVersion":"1","base":"a","base":"b"}');
  const result = scan(root); assert.equal(result.status, 2); assert.equal(result.report.reportKind, 'error');
}));

test('root inside an ancestor repository does not inventory that ancestor', async () => fixture(async root => {
  await repo(root, '.'); await mkdir(path.join(root, 'directory'));
  const result = scan(path.join(root, 'directory')); assert.equal(result.status, 1);
  assert.equal(result.report.repositories.length, 0); assert.ok(result.stderr.includes('ROOT_INSIDE_REPOSITORY'));
  assert.equal(await canonicalRoot(root), await realpath(root));
}));

test('workspace relocation preserves IDs and configured missing repos remain observable', async () => fixture(async root => {
  const first = path.join(root, 'first'); await mkdir(first); await repo(first, 'a');
  const before = scan(first); const moved = path.join(root, 'moved'); await rename(first, moved);
  const after = scan(moved); assert.equal(after.status, 0, after.stderr);
  assert.equal(before.report.repositories[0]!.repositoryId, after.report.repositories[0]!.repositoryId);
  await writeFile(path.join(moved, '.difflearn.json'), JSON.stringify({ configVersion: '1', repositories: [{ path: 'missing' }] }));
  const missing = scan(moved); assert.equal(missing.status, 1);
  assert.ok(missing.report.diagnostics.some(item => item.code === 'CONFIGURED_REPOSITORY_NOT_FOUND'));
}));

test('directory/repository budgets are deterministic and preserve the retained prefix', async () => fixture(async root => {
  await repo(root, 'a'); await repo(root, 'b');
  for (const limits of [{ maxDirectories: 2 }, { maxRepositories: 1 }]) {
    await writeFile(path.join(root, '.difflearn.json'), JSON.stringify({ configVersion: '1', limits }));
    const result = scan(root); assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.report.repositories.map(item => item.path), ['a']);
    assert.equal(result.report.discovery.remainingCount, null);
  }
}));

test('a worktree can use external Git metadata while outside worktrees are never enumerated', async () => fixture(async root => {
  await fixture(async outside => {
    const main = await repo(outside, 'main'); git(main, 'commit', '--allow-empty', '-m', 'synthetic');
    git(main, 'worktree', 'add', '-b', 'inside', path.join(root, 'inside'));
    const result = scan(root); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.report.repositories.map(item => item.path), ['inside']);
    assert.ok(result.report.repositories[0]!.commonDirectory!.startsWith(outside));
  });
}));

test('Git environment redirects are cleared and metadata output limits terminate cleanly', async () => fixture(async root => {
  await repo(root, 'a'); const foreign = await repo(root, 'foreign');
  const result = spawnSync(process.execPath, [cli, 'scan', '--root', path.join(root, 'a'), '--json'], { encoding: 'utf8', env: { ...process.env, GIT_DIR: path.join(foreign, '.git'), GIT_WORK_TREE: foreign } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { repositories: { topLevel: string }[] };
  assert.equal(report.repositories[0]!.topLevel, await realpath(path.join(root, 'a')));
  await assert.rejects(runGit(root, ['--version'], { ...defaultLimits, maxMetadataBytes: 1 }), /metadata exceeded/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runGit(root, ['--version'], defaultLimits, controller.signal), /Scan interrupted/);
}));

test('a wholly unreadable root is failed, not an empty successful inventory', async () => fixture(async root => {
  const io: DiscoveryIO = { git: runGit, readDirectory: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  const result = await discover(await realpath(root), { configVersion: '1' }, defaultLimits, [], io);
  assert.equal(result.completeness.state, 'failed'); assert.equal(result.discovery.readableDirectories, 0);
  assert.ok(result.diagnostics.some(item => item.code === 'TRAVERSAL_FAILED'));
}));
