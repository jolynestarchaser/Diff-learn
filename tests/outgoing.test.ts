import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runGit } from '../src/git/runner.js';
const { captureOutgoing, collectOutgoingEvidence }: typeof import('../src/ui/outgoing.js') = await import(pathToFileURL(fileURLToPath(new URL('../../dist/ui/outgoing.js', import.meta.url))).href);
const { collectLocalEvidence }: typeof import('../src/ui/local.js') = await import(pathToFileURL(fileURLToPath(new URL('../../dist/ui/local.js', import.meta.url))).href);
const { startUi }: typeof import('../src/ui/server.js') = await import(pathToFileURL(fileURLToPath(new URL('../../dist/ui/server.js', import.meta.url))).href);
const signal = () => new AbortController().signal;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'difflearn-outgoing-')), root = path.join(directory, 'repository ไทย spaces'); await mkdir(root);
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=.git/no-fixture-hooks', '-c', 'user.name=Synthetic ไทย', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args], { cwd: root, env, encoding: 'utf8' });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout.trimEnd();
  };
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, '.git', 'fixture-ignore'), ''); await writeFile(path.join(root, '.git', 'fixture-attributes'), '');
  git('config', 'core.excludesFile', '.git/fixture-ignore'); git('config', 'core.attributesFile', '.git/fixture-attributes');
  const java = (value: string) => `package synthetic; class บริการ { String ชื่อ() { return "${value}"; } }\r\n`;
  await writeFile(path.join(root, 'บริการ.java'), java('base')); git('add', '.'); git('commit', '-m', 'base'); const base = git('rev-parse', 'HEAD');
  const upstream = (oid: string) => { git('update-ref', 'refs/remotes/fixture/main', oid); git('config', 'remote.fixture.url', 'https://example.invalid/never-contact'); git('config', 'remote.fixture.fetch', '+refs/heads/*:refs/remotes/fixture/*'); git('config', 'branch.main.remote', 'fixture'); git('config', 'branch.main.merge', 'refs/heads/main'); };
  const commit = async (value: string) => { await writeFile(path.join(root, 'บริการ.java'), java(value)); git('add', '.'); git('commit', '-m', `${value} <img src=x onerror=alert(1)>`); return git('rev-parse', 'HEAD'); };
  return { directory, root, git, java, base, upstream, commit, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
test('outgoing individual and aggregate evidence pins exact commit blobs, provenance and Java; index stays physically unchanged', async () => {
  const f = await fixture();
  try {
    f.upstream(f.base); const first = await f.commit('first'), second = await f.commit('second');
    await writeFile(path.join(f.root, 'บริการ.java'), f.java('staged')); f.git('add', '.'); await writeFile(path.join(f.root, 'บริการ.java'), f.java('working'));
    const index = path.join(f.root, '.git', 'index'), bytes = await readFile(index), info = await stat(index, { bigint: true });
    const catalog = await captureOutgoing(f.root, signal()); assert.equal(catalog.comparison?.ref, 'refs/remotes/fixture/main'); assert.equal(catalog.comparison.oid, f.base); assert.equal(catalog.ahead, 2); assert.equal(catalog.behind, 0);
    assert.deepEqual(catalog.commits.map(commit => [commit.oid, commit.parents]), [[second, [first]], [first, [f.base]]]); assert.match(catalog.commits[0]!.subject, /<img/u); assert.equal(catalog.commits[0]!.author, 'Synthetic ไทย'); assert.match(catalog.commits[0]!.date, /^\d{4}-/u);
    for (const [commit, before, afterText] of [[first, f.base, 'first'], [null, f.base, 'second']] as const) {
      const bundle = await collectOutgoingEvidence(f.root, catalog, { mode: 'unpushed', commit }, signal()); assert.ok(bundle); assert.equal(bundle.schemaVersion, '1.3.0'); assert.equal(bundle.completeness.state, 'complete', JSON.stringify(bundle.diagnostics));
      assert.equal(bundle.repositories[0]!.comparisons[0]!.before.oid, before); assert.equal(bundle.repositories[0]!.comparisons[0]!.after.oid, commit ?? second);
      const lines = bundle.evidence.filter(entry => entry.kind === 'hunk').flatMap(entry => entry.data.lines); assert.ok(lines.some(line => line.kind === 'add' && line.content?.includes(afterText))); assert.ok(!lines.some(line => /staged|working/u.test(line.content ?? '')));
      const sources = bundle.evidence.filter(entry => entry.kind === 'language-analysis').flatMap(entry => entry.data.sources); assert.ok(sources.every(source => source.origin === 'git-blob'));
      assert.ok(bundle.evidence.some(entry => entry.kind === 'symbol' && entry.data.name === 'ชื่อ'));
      const hunk = bundle.evidence.find(entry => entry.kind === 'hunk')!; assert.ok(hunk.source.kind === 'diff-parser' && hunk.source.arguments.includes(`--attr-source=${commit ?? second}`));
    }
    const current = await collectLocalEvidence(f.root, signal()); assert.ok(current.evidence.some(entry => entry.kind === 'hunk' && entry.data.lines.some(line => line.content?.includes('working'))));
    const after = await stat(index, { bigint: true }); assert.deepEqual(await readFile(index), bytes); assert.deepEqual([after.ino, after.size, after.mode, after.mtimeNs, after.ctimeNs], [info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs]);
  } finally { await f.cleanup(); }
});
test('merge commits retain actual parents and use the first parent; divergence uses the unique merge base for net diff', async () => {
  const f = await fixture();
  try {
    f.upstream(f.base); f.git('checkout', '-b', 'topic'); await writeFile(path.join(f.root, 'Topic.java'), 'class Topic {}\n'); f.git('add', '.'); f.git('commit', '-m', 'topic'); const topic = f.git('rev-parse', 'HEAD');
    f.git('checkout', 'main'); const first = await f.commit('main'); f.git('merge', '--no-ff', 'topic', '-m', 'merge'); const merge = f.git('rev-parse', 'HEAD');
    const upstream = f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'upstream-only'); f.upstream(upstream);
    const catalog = await captureOutgoing(f.root, signal()); assert.equal(catalog.ahead, 3); assert.equal(catalog.behind, 1); assert.equal(catalog.diverged, true); assert.deepEqual(catalog.mergeBases, [f.base]); assert.deepEqual(catalog.commits.find(commit => commit.oid === merge)?.parents, [first, topic]); assert.ok(catalog.commits.some(commit => commit.oid === topic));
    const individual = await collectOutgoingEvidence(f.root, catalog, { mode: 'unpushed', commit: merge }, signal()); assert.ok(individual); assert.equal(individual.repositories[0]!.comparisons[0]!.before.oid, first); assert.deepEqual(individual.evidence.filter(entry => entry.kind === 'file-change').map(entry => entry.data.destinationPath), ['Topic.java']);
    const aggregate = await collectOutgoingEvidence(f.root, catalog, { mode: 'unpushed', commit: null }, signal()); assert.ok(aggregate); assert.deepEqual(aggregate.evidence.filter(entry => entry.kind === 'file-change').map(entry => entry.data.destinationPath).sort(), ['Topic.java', 'บริการ.java'].sort());
  } finally { await f.cleanup(); }
});
test('root commits use empty tree while unrelated ancestry retains individual review and disables aggregate', async () => {
  const f = await fixture();
  try {
    const unrelated = f.git('commit-tree', `${f.base}^{tree}`, '-m', 'unrelated root'); f.upstream(unrelated);
    const catalog = await captureOutgoing(f.root, signal()); assert.deepEqual(catalog.commits[0]?.parents, []); assert.match(catalog.aggregateReason!, /no common ancestor/u);
    assert.equal(await collectOutgoingEvidence(f.root, catalog, { mode: 'unpushed', commit: null }, signal()), null);
    const root = await collectOutgoingEvidence(f.root, catalog, { mode: 'unpushed', commit: f.base }, signal()); assert.ok(root); assert.equal(root.completeness.state, 'complete', JSON.stringify(root.diagnostics)); assert.equal(root.repositories[0]!.comparisons[0]!.before.kind, 'empty-tree'); assert.ok(root.evidence.some(entry => entry.kind === 'symbol' && entry.data.name === 'บริการ'));
  } finally { await f.cleanup(); }
});
test('multiple merge bases disable aggregate without withholding valid individual commit evidence', async () => {
  const f = await fixture();
  try {
    const a = f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'a'), b = f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'b');
    const left = f.git('commit-tree', `${f.base}^{tree}`, '-p', a, '-p', b, '-m', 'left'), right = f.git('commit-tree', `${f.base}^{tree}`, '-p', b, '-p', a, '-m', 'right'); f.git('update-ref', 'refs/heads/main', left); f.upstream(right);
    const catalog = await captureOutgoing(f.root, signal()); assert.deepEqual(catalog.mergeBases, [a, b].sort()); assert.match(catalog.aggregateReason!, /Multiple merge bases/u);
    assert.equal(await collectOutgoingEvidence(f.root, catalog, { mode: 'unpushed', commit: null }, signal()), null); assert.ok(await collectOutgoingEvidence(f.root, catalog, { mode: 'unpushed', commit: left }, signal()));
  } finally { await f.cleanup(); }
});
test('missing/no upstream, explicit local choice, empty outgoing, detached HEAD and unborn branch have honest states', async () => {
  const f = await fixture();
  try {
    assert.equal((await captureOutgoing(f.root, signal())).status, 'no-upstream'); f.upstream(f.base);
    assert.equal((await captureOutgoing(f.root, signal())).status, 'empty'); f.git('update-ref', '-d', 'refs/remotes/fixture/main'); assert.equal((await captureOutgoing(f.root, signal())).status, 'missing-upstream');
    f.git('tag', 'comparison', f.base); await f.commit('local'); const chosen = await captureOutgoing(f.root, signal(), 'refs/tags/comparison'); assert.equal(chosen.comparison?.kind, 'chosen'); assert.equal(chosen.ahead, 1);
    await assert.rejects(captureOutgoing(f.root, signal(), 'origin/main'), { code: 'COMPARISON_REF_MISSING' }); f.git('checkout', '--detach'); assert.equal((await captureOutgoing(f.root, signal())).status, 'detached'); assert.equal((await captureOutgoing(f.root, signal(), 'refs/tags/comparison')).comparison?.kind, 'chosen');
    f.git('symbolic-ref', 'HEAD', 'refs/heads/unborn'); assert.equal((await captureOutgoing(f.root, signal())).status, 'unborn');
  } finally { await f.cleanup(); }
});
test('shallow boundary preserves real missing parents and cannot be misreported as a root commit', async () => {
  const f = await fixture();
  try {
    const parent = f.base; await f.commit('shallow'); const clone = path.join(f.directory, 'shallow clone'); f.git('clone', '--depth=1', '--no-local', pathToFileURL(f.root).href, clone);
    const cwdGit = (...args: string[]) => { const result = spawnSync('git', ['-c', 'core.hooksPath=.git/no-hooks', '-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: clone, env, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    const other = cwdGit('commit-tree', 'HEAD^{tree}', '-m', 'unrelated'); cwdGit('update-ref', 'refs/heads/comparison', other);
    const catalog = await captureOutgoing(clone, signal(), 'refs/heads/comparison'); assert.equal(catalog.shallow, true); assert.deepEqual(catalog.commits[0]?.parents, [parent]); assert.match(catalog.commits[0]!.unavailableReason!, /not a root commit/u); assert.match(catalog.aggregateReason!, /Shallow/u);
    assert.equal(await collectOutgoingEvidence(clone, catalog, { mode: 'unpushed', commit: catalog.commits[0]!.oid }, signal()), null);
  } finally { await f.cleanup(); }
});
test('moving upstream during capture discards metadata; later review remains pinned to captured IDs', async () => {
  const f = await fixture();
  try {
    f.upstream(f.base); const head = await f.commit('local'); let captures = 0;
    await assert.rejects(captureOutgoing(f.root, signal(), undefined, async (...args) => {
      if (args[1][0] === 'for-each-ref' && args[1][1]?.startsWith('--format=%(refname)') && ++captures === 2) f.git('update-ref', 'refs/remotes/fixture/main', head);
      return runGit(...args);
    }), { code: 'OUTGOING_CHANGED' });
    f.upstream(f.base); const captured = await captureOutgoing(f.root, signal()); f.upstream(head);
    const bundle = await collectOutgoingEvidence(f.root, captured, { mode: 'unpushed', commit: head }, signal()); assert.ok(bundle); assert.equal(bundle.repositories[0]!.comparisons[0]!.before.oid, f.base); assert.equal(captured.comparison!.oid, f.base); assert.equal((await captureOutgoing(f.root, signal())).status, 'empty');
    await writeFile(path.join(f.root, '.difflearn.json'), JSON.stringify({ configVersion: '1', limits: { maxPatchBytes: 1 } })); const partial = await collectOutgoingEvidence(f.root, captured, { mode: 'unpushed', commit: head }, signal()); assert.equal(partial?.completeness.state, 'partial');
  } finally { await f.cleanup(); }
});
test('live bridge exposes both modes, immutable generations, authenticated selections and local-ref refresh', async () => {
  const f = await fixture();
  let server: Awaited<ReturnType<typeof startUi>> | undefined;
  try {
    f.upstream(f.base); f.git('tag', 'comparison', f.base); const commit = await f.commit('local'); await writeFile(path.join(f.root, 'บริการ.java'), f.java('working'));
    server = await startUi(null, { local: { root: f.root, branch: 'main', collect: s => collectLocalEvidence(f.root, s), history: { capture: (s, ref) => captureOutgoing(f.root, s, ref), collect: (catalog, selection, s) => collectOutgoingEvidence(f.root, catalog, selection, s) } } });
    const html = await (await fetch(server.url)).text(), token = JSON.parse(/id="difflearn-bootstrap"[^>]*>([^<]+)</u.exec(html)![1]!).token as string;
    const api = (route: string, method = 'GET', origin = new URL(server!.url).origin) => fetch(new URL(route, server!.url), { method, headers: { 'X-Difflearn-Session': token, Origin: origin } });
    const ready = async (generation: number) => { for (let i = 0; i < 500; i++) { const state = await (await api('/api/state')).json(); if (state.phase === 'error') throw new Error(JSON.stringify(state.error)); if (state.phase === 'ready' && state.generation >= generation) return state; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Collection timeout'); };
    const first = await ready(1); assert.equal(first.reviewSelection.mode, 'uncommitted'); assert.equal(first.outgoing.comparison.oid, f.base);
    assert.equal((await api('/api/review?mode=unpushed', 'POST', '')).status, 403); assert.equal((await api('/api/review?mode=other', 'POST')).status, 400); assert.equal((await api(`/api/review?mode=unpushed&commit=${'0'.repeat(40)}`, 'POST')).status, 400); assert.equal((await api('/api/review?mode=unpushed&comparisonRef=origin/main', 'POST')).status, 400);
    assert.equal((await api(`/api/review?mode=unpushed&commit=${commit}`, 'POST')).status, 202); const individual = await ready(2); assert.equal(individual.reviewSelection.commit, commit); assert.equal(individual.scope, 'branch'); assert.deepEqual(await (await api('/api/session?generation=1')).json(), first.snapshot);
    assert.equal((await api('/api/review?mode=unpushed', 'POST')).status, 202); assert.equal((await ready(3)).reviewSelection.commit, null);
    f.upstream(commit); assert.equal((await api('/api/refresh', 'POST')).status, 202); const empty = await ready(4); assert.equal(empty.outgoing.status, 'empty'); assert.equal(empty.snapshot, null); assert.equal((await api('/api/session?generation=4')).status, 409);
    assert.equal((await api('/api/review?mode=uncommitted', 'POST')).status, 202); assert.equal((await ready(5)).scope, 'all');
    f.git('config', '--unset', 'branch.main.remote'); f.git('config', '--unset', 'branch.main.merge');
    assert.equal((await api('/api/refresh', 'POST')).status, 202); assert.equal((await ready(6)).outgoing.status, 'no-upstream');
    assert.equal((await api('/api/review?mode=unpushed', 'POST')).status, 202); assert.equal((await ready(7)).snapshot, null);
    assert.equal((await api('/api/review?mode=unpushed&comparisonRef=refs%2Ftags%2Fcomparison', 'POST')).status, 202); const chosen = await ready(8); assert.equal(chosen.outgoing.comparison.kind, 'chosen'); assert.equal(chosen.outgoing.comparison.oid, f.base); assert.equal(chosen.outgoing.ahead, 1); assert.ok(chosen.snapshot);
  } finally { await server?.close(); await f.cleanup(); }
});
