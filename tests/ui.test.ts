import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { readFile, mkdtemp, writeFile, rm, symlink, open as openFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { readEvidenceBundle, loadEvidenceBundle } from '../src/evidence/read.js';
import type { UiSession, UiPage, UiEvidence, UiInspection } from '../src/ui/contracts.js';

// Exercise built assets and the same module path shipped in the real package.
const startUi: typeof import('../src/ui/server.js')['startUi'] = (await import(pathToFileURL(fileURLToPath(new URL('../../dist/ui/server.js', import.meta.url))).href)).startUi;
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
