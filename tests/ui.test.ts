import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { readFile, mkdtemp, writeFile, rm, symlink, stat, mkdir, open as openFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { readEvidenceBundle, loadEvidenceBundle } from '../src/evidence/read.js';
import type { UiSession, UiPage, UiEvidence, UiInspection, UiAppState } from '../src/ui/contracts.js';

// Exercise built assets and the same module path shipped in the real package.
const startUi: typeof import('../src/ui/server.js')['startUi'] = (await import(pathToFileURL(fileURLToPath(new URL('../../dist/ui/server.js', import.meta.url))).href)).startUi;
const { collectLocalEvidence, findLocalRepository }: typeof import('../src/ui/local.js') = await import(pathToFileURL(fileURLToPath(new URL('../../dist/ui/local.js', import.meta.url))).href);
const { launchLocalApp }: typeof import('../src/cli/local.js') = await import(pathToFileURL(fileURLToPath(new URL('../../dist/cli/local.js', import.meta.url))).href);
const { openBrowser }: typeof import('../src/ui/browser.js') = await import(pathToFileURL(fileURLToPath(new URL('../../dist/ui/browser.js', import.meta.url))).href);
const historical = async (version = '1.0.0') => readEvidenceBundle(JSON.parse(await readFile(new URL(`../../tests/fixtures/evidence/${version}.json`, import.meta.url), 'utf8')));
async function open(value: unknown, options: Parameters<typeof startUi>[1] = {}) {
  const server = await startUi(value, options); const response = await fetch(server.url), html = await response.text(); assert.equal(response.status, 200);
  const secret = /<script id="difflearn-bootstrap"[^>]*>([^<]+)<\/script>/u.exec(html); assert.ok(secret);
  const { token } = JSON.parse(secret[1]!) as { token: string }; assert.match(token, /^[a-f0-9]{64}$/u);
  const get = (route: string, headers: Record<string, string> = {}) => fetch(new URL(route, server.url), { headers: { 'X-Difflearn-Session': token, ...headers } });
  return { server, response, html, token, get };
}
function raw(url: string, route: string, headers: Record<string, string> = {}, method = 'GET', body = ''): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const origin = new URL(url); const req = request({ hostname: origin.hostname, port: origin.port, path: route, method, headers, timeout: 5000 }, response => { let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, body: text })); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Synthetic request timed out'))); req.end(body);
  });
}
async function settled(get: (route: string) => Promise<Response>, generation: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await (await get('/api/state')).json() as UiAppState;
    if (state.generation >= generation || state.phase === 'error') return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Local collection did not settle');
}

test('local bridge serves immediately, serializes refresh, validates replacements, pins generations and aborts collection on shutdown', async () => {
  let release: (value: unknown) => void = () => {}, calls = 0, aborted = false;
  const { server, get, token } = await open(null, { local: { root: 'synthetic ไทย root', branch: 'main', collect: signal => {
    calls++; return new Promise(resolve => { release = resolve; signal.addEventListener('abort', () => { aborted = true; resolve(null); }, { once: true }); });
  } } });
  const post = (headers: Record<string, string> = {}, route = '/api/refresh', body = '') => raw(server.url, route, { Host: new URL(server.url).host, 'X-Difflearn-Session': token, Origin: new URL(server.url).origin, ...headers }, 'POST', body);
  try {
    assert.equal(calls, 1); assert.equal(((await (await get('/api/state')).json()) as UiAppState).phase, 'loading'); assert.equal((await get('/api/session')).status, 409);
    assert.equal((await post()).status, 409); assert.equal((await post({ Origin: '' })).status, 403); assert.equal((await post({ 'Content-Length': '1' }, '/api/refresh', 'x')).status, 413);
    release(await historical()); const first = await settled(get, 1); assert.equal(first.phase, 'ready'); assert.equal(first.snapshot?.expiresAt, null);
    assert.equal((await post()).status, 202); assert.equal(calls, 2); assert.equal((await post()).status, 409);
    assert.deepEqual(await (await get('/api/session?generation=1')).json(), first.snapshot);
    const partial = readEvidenceBundle(JSON.parse(await readFile(new URL('../../tests/fixtures/ui/java.json', import.meta.url), 'utf8'))); release(partial);
    const second = await settled(get, 2); assert.equal(second.snapshot?.schemaVersion, '1.3.0'); assert.equal(second.snapshot?.completeness.state, 'partial');
    assert.deepEqual(await (await get('/api/session?generation=1')).json(), first.snapshot);
    assert.equal((await get('/api/session?generation=2&generation=1')).status, 400); assert.equal((await get('/api/session?generation=3')).status, 409);
    assert.equal((await post({}, '/api/refresh?root=elsewhere')).status, 400);
    assert.equal((await post()).status, 202); release({ schemaVersion: 'invalid' });
    const failed = await settled(get, 3); assert.equal(failed.phase, 'error'); assert.equal(failed.generation, 2); assert.deepEqual(failed.snapshot, second.snapshot); assert.ok(failed.error);
    assert.equal((await post()).status, 202); await server.close(); assert.ok(aborted); await server.done; await assert.rejects(fetch(server.url));
  } finally { await server.close(); }
});

test('bare local collection resolves roots, subdirectories and external Thai/space worktrees without changing physical index or needing a remote', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'difflearn-local-'));
  const root = path.join(temporary, 'repository ไทย with spaces'); await mkdir(root);
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=.git/no-fixture-hooks', '-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args], { cwd: root, env: cleanEnv });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr.toString()); return result.stdout.toString('utf8').trimEnd();
  };
  try {
    git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false');
    const filename = path.join(root, 'บริการ.java'); const original = 'class บริการ { String ชื่อ() { return "ก่อน😀"; } }\r\n';
    await writeFile(filename, original); git('add', '.'); git('commit', '-m', 'fixture');
    const subdirectory = path.join(root, 'sub ไทย'); await mkdir(subdirectory);
    const canonical = (await findLocalRepository(root)).root;
    assert.equal((await findLocalRepository(subdirectory)).root, canonical);
    const empty = await collectLocalEvidence(canonical, new AbortController().signal); assert.equal(empty.request.base, 'HEAD'); assert.deepEqual(empty.request.scopes, ['all']); assert.equal(empty.completeness.state, 'complete'); assert.equal(empty.evidence.filter(entry => entry.kind === 'file-change').length, 0);
    await writeFile(filename, original.replace('ก่อน', 'index')); git('add', '.'); await writeFile(filename, original.replace('ก่อน', 'หลัง'));
    const index = path.join(root, '.git', 'index'), indexBytes = await readFile(index), before = await stat(index, { bigint: true });
    const bundle = await collectLocalEvidence(canonical, new AbortController().signal);
    assert.equal(bundle.schemaVersion, '1.3.0'); assert.equal(bundle.completeness.state, 'complete', JSON.stringify(bundle.diagnostics));
    assert.ok(bundle.evidence.some(entry => entry.kind === 'symbol' && entry.data.name === 'ชื่อ'));
    const lines = bundle.evidence.filter(entry => entry.kind === 'hunk').flatMap(entry => entry.data.lines);
    assert.ok(lines.some(line => line.kind === 'remove' && line.content?.includes('ก่อน'))); assert.ok(lines.some(line => line.kind === 'add' && line.content?.includes('หลัง'))); assert.ok(!lines.some(line => line.content?.includes('index')));
    const after = await stat(index, { bigint: true }); assert.deepEqual(await readFile(index), indexBytes); assert.deepEqual([after.ino, after.size, after.mtimeNs, after.ctimeNs, after.mode], [before.ino, before.size, before.mtimeNs, before.ctimeNs, before.mode]);
    // all means net HEAD→working tree, so a staged edit canceled by the worktree is empty.
    await writeFile(filename, original); const canceled = await collectLocalEvidence(canonical, new AbortController().signal); assert.equal(canceled.evidence.filter(entry => entry.kind === 'file-change').length, 0);
    const worktree = path.join(temporary, 'external worktree ไทย'); git('worktree', 'add', '-b', 'review-local', worktree);
    const workSubdirectory = path.join(worktree, 'sub dir'); await mkdir(workSubdirectory);
    const found = await findLocalRepository(workSubdirectory); assert.equal(found.branch, 'review-local'); assert.equal(path.relative(await (await import('node:fs/promises')).realpath(worktree), found.root), '');
    await writeFile(path.join(worktree, 'บริการ.java'), original.replace('ก่อน', 'worktree'));
    const work = await collectLocalEvidence(found.root, new AbortController().signal); assert.ok(work.evidence.some(entry => entry.kind === 'symbol' && entry.data.name === 'ชื่อ')); assert.equal(work.repositories.length, 1);
    await writeFile(path.join(worktree, '.difflearn.json'), JSON.stringify({ configVersion: '1', limits: { maxPatchBytes: 1 } }));
    const partial = await collectLocalEvidence(found.root, new AbortController().signal); assert.equal(partial.completeness.state, 'partial'); assert.ok(partial.completeness.reasons.length);
    await assert.rejects(findLocalRepository(temporary), { code: 'REPOSITORY_REQUIRED' });
    await assert.rejects(openBrowser('https://example.invalid/'));
  } finally { assert.ok(path.relative(os.tmpdir(), temporary).startsWith('difflearn-local-')); await rm(temporary, { recursive: true, force: true }); }
});

test('launcher opens the ready server once, retains URL on browser failure and exits after cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'difflearn-launch-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync('git', ['init', '-b', 'main'], { cwd: root, env }); assert.ifError(result.error); assert.equal(result.status, 0);
  const controller = new AbortController(); let calls = 0, output = '';
  const saved = process.env.DIFFLEARN_NO_BROWSER; delete process.env.DIFFLEARN_NO_BROWSER;
  try {
    const running = launchLocalApp(root, controller.signal, { write: message => { output += message; return true; }, open: async url => { calls++; assert.equal((await fetch(url)).status, 200); throw new Error('Synthetic opener failure'); } });
    for (let i = 0; i < 100 && !output.includes('Could not open'); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(calls, 1); assert.match(output, /Could not open the browser\. Open http:\/\/127\.0\.0\.1:\d+\//u); const url = /http:\/\/127\.0\.0\.1:\d+\//u.exec(output)![0]; assert.equal((await fetch(url)).status, 200);
    controller.abort(); await assert.rejects(running); await assert.rejects(fetch(url));
  } finally { controller.abort(); if (saved === undefined) delete process.env.DIFFLEARN_NO_BROWSER; else process.env.DIFFLEARN_NO_BROWSER = saved; assert.ok(path.relative(os.tmpdir(), root).startsWith('difflearn-launch-')); await rm(root, { recursive: true, force: true }); }
});
test('production bridge accepts each historical version, retaining original IDs, hunks, provenance and coverage', async () => {
  for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
    const bundle = await historical(version); const { server, get, html, token, response } = await open(bundle);
    try {
      assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/u); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('access-control-allow-origin'), null);
      const session = await (await get('/api/session')).json() as UiSession; assert.equal(session.schemaVersion, version); assert.equal(session.freshness, 'not-verified'); assert.equal(session.readOnly, true); assert.ok(!JSON.stringify(session).includes(token));
      const repositories = await (await get('/api/repositories?limit=1')).json() as UiPage<typeof bundle.repositories[number]>; assert.deepEqual(repositories.items[0], bundle.repositories[0]);
      const files = await (await get(`/api/files?repositoryId=${repositories.items[0]!.repositoryId}`)).json() as UiPage<UiEvidence>; const file = files.items[0]!; assert.equal(file.kind, 'file-change');
      const hunks = await (await get(`/api/hunks?fileEvidenceId=${file.id}`)).json() as UiPage<UiEvidence>; assert.deepEqual(hunks.items, bundle.evidence.filter(entry => entry.kind === 'hunk' && entry.data.fileEvidenceId === file.id));
      const inspected = await (await get(`/api/inspect?evidenceId=${hunks.items[0]!.id}`)).json() as UiInspection; assert.deepEqual(inspected.entry, hunks.items[0]); assert.deepEqual(inspected.completeness, bundle.completeness);
      const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)].map(match => match[1]!); assert.ok(assetPaths.some(asset => asset.endsWith('.js')) && assetPaths.some(asset => asset.endsWith('.css')));
      for (const asset of assetPaths) assert.equal((await fetch(new URL(asset, server.url))).status, 200);
      const body = await (await get('/api/session')).text(); assert.ok(!body.includes('tree-sitter-java.node'));
    } finally { await server.close(); }
  }
});
test('bridge rejects cross-site/Host/token/method/body/traversal/arbitrary-file and unbounded query requests', async () => {
  const { server, get, token } = await open(await historical());
  try {
    assert.equal((await fetch(new URL('/api/session', server.url))).status, 403);
    const blockedHeaders: Record<string, string>[] = [{ Origin: 'https://example.invalid' }, { Host: 'example.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-Difflearn-Session': 'f'.repeat(64) }, { 'X-Difflearn-Session': 'é'.repeat(64) }];
    // Fetch implementations may replace forbidden Host/Sec-Fetch headers.
    for (const headers of blockedHeaders) assert.equal((await raw(server.url, '/api/session', { 'X-Difflearn-Session': token, ...headers })).status, 403, JSON.stringify(headers));
    assert.equal((await fetch(new URL('/api/session', server.url), { method: 'POST', headers: { 'X-Difflearn-Session': token } })).status, 405);
    const secret = { 'X-Difflearn-Session': token };
    assert.equal((await raw(server.url, '/api/session', { ...secret, 'Content-Length': '1' }, 'GET', 'x')).status, 413);
    for (const route of ['/../package.json', '/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json', '/assets/%5cpackage.json']) assert.equal((await raw(server.url, route, secret)).status, 400);
    for (const route of ['/api/file?path=package.json', '/api/review', '/api/refresh', '/package.json', '/.vite/manifest.json']) assert.equal((await get(route)).status, 404);
    for (const route of ['/api/repositories?limit=101', '/api/repositories?offset=-1', '/api/repositories?limit=1&limit=2', '/api/session?token=anything', '/api/files?repositoryId=../../x', '/api/session?' + 'q'.repeat(2048)]) assert.equal((await get(route)).status, 400);
    assert.equal((await get(`/api/inspect?evidenceId=${'0'.repeat(64)}`)).status, 404);
    assert.equal((await get('/api/repositories?offset=999999')).status, 200);
  } finally { await server.close(); }
});
test('sessions freeze accepted data; TTL and cancellation shut down the loopback listener', async () => {
  const input = await historical(); const before = input.request.root; const { server, get } = await open(input);
  try { input.request.root = 'C:/synthetic/changed-after-start'; assert.equal(((await (await get('/api/session')).json()) as UiSession).root, before); } finally { await server.close(); }
  const controller = new AbortController(); const aborted = await startUi(await historical(), { signal: controller.signal }); controller.abort(); await aborted.done; await assert.rejects(fetch(aborted.url));
  const expired = await startUi(await historical(), { lifetimeMs: 20 }); await expired.done; await assert.rejects(fetch(expired.url));
});
test('shared loader rejects invalid versions/IDs, oversized/malformed/encoding/symlink inputs without touching the export', async () => {
  await assert.rejects(startUi({ schemaVersion: '9.0.0' }), { code: 'EVIDENCE_VERSION_UNSUPPORTED' });
  const broken = await historical(); broken.evidence[0]!.id = '0'.repeat(64); await assert.rejects(startUi(broken), { code: 'INTERNAL_CONTRACT_ERROR' });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'difflearn-ui-read-'));
  try {
    const filename = path.join(directory, 'export.json'); const bytes = Buffer.from('{"schemaVersion":"1.0.0"}'); await writeFile(filename, bytes);
    await assert.rejects(loadEvidenceBundle(filename)); assert.deepEqual(await readFile(filename), bytes);
    await writeFile(filename, Buffer.from([0xff])); await assert.rejects(loadEvidenceBundle(filename), { code: 'EVIDENCE_INVALID' });
    await writeFile(filename, '{broken'); await assert.rejects(loadEvidenceBundle(filename), { code: 'EVIDENCE_INVALID' });
    const handle = await openFile(filename, 'w'); await handle.truncate(64 * 1024 * 1024 + 1); await handle.close(); await assert.rejects(loadEvidenceBundle(filename), { code: 'EVIDENCE_INVALID' });
    await assert.rejects(loadEvidenceBundle(directory), { code: 'EVIDENCE_INVALID' });
    const alias = path.join(directory, 'alias.json');
    try { await symlink(filename, alias); await assert.rejects(loadEvidenceBundle(alias), { code: 'EVIDENCE_INVALID' }); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error; }
  } finally { const relative = path.relative(os.tmpdir(), directory); assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); await rm(directory, { recursive: true, force: true }); }
});
