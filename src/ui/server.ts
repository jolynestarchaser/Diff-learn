import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScanError } from '../config/load.js';
import { readEvidenceBundle } from '../evidence/read.js';
import { createUiProjection, UiRequestError } from './projection.js';

const assetDirectory = fileURLToPath(new URL('../ui-assets/', import.meta.url));
async function assets() {
  const map = new Map<string, { bytes: Buffer; type: string }>(); let total = 0;
  const names = ['index.html', ...(await readdir(path.join(assetDirectory, 'assets'))).map(name => `assets/${name}`)];
  if (names.length > 32) throw new ScanError('UI_ASSET_INVALID', 'Production UI assets exceed their file bound', 1);
  for (const name of names) {
    if (name !== 'index.html' && !/^assets\/[A-Za-z0-9_-]+\.(?:js|css)$/u.test(name)) throw new ScanError('UI_ASSET_INVALID', 'Unexpected production UI asset', 1);
    const filename = path.join(assetDirectory, name), info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 5 * 1024 * 1024 || (total += info.size) > 10 * 1024 * 1024) throw new ScanError('UI_ASSET_INVALID', 'Production assets must be bounded regular files', 1);
    map.set(`/${name}`, { bytes: await readFile(filename), type: name.endsWith('.html') ? 'text/html;charset=utf-8' : name.endsWith('.css') ? 'text/css;charset=utf-8' : 'text/javascript;charset=utf-8' });
  }
  return map;
}
export async function startUi(value: unknown, options: { signal?: AbortSignal; lifetimeMs?: number } = {}) {
  options.signal?.throwIfAborted();
  const bundle = readEvidenceBundle(structuredClone(value)), staticAssets = await assets();
  const lifetime = options.lifetimeMs ?? 30 * 60_000;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 60 * 60_000) throw new ScanError('UI_SESSION_INVALID', 'Session lifetime exceeds its bound', 1);
  const token = randomBytes(32).toString('hex'), nonce = randomBytes(18).toString('base64');
  const project = createUiProjection(bundle, new Date(Date.now() + lifetime).toISOString());
  let origin = '', host = ''; let closed = false;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'`);
    const error = (status: number, message: string) => { response.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' }); response.end(JSON.stringify({ error: message })); };
    try {
      if (closed || request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== host || request.headers.origin !== undefined && request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') throw new UiRequestError(403, 'Only this same-origin loopback session is allowed');
      if (request.method !== 'GET') throw new UiRequestError(405, 'This viewer supports read-only GET requests');
      if (request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0') throw new UiRequestError(413, 'Request bodies are not accepted');
      const raw = request.url ?? ''; if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > 2048) throw new UiRequestError(400, 'Invalid or oversized request target');
      const decoded = decodeURIComponent(raw.split('?')[0]!);
      if (decoded.includes('\\') || decoded.split('/').some(part => part === '.' || part === '..')) throw new UiRequestError(400, 'Asset traversal is not accepted');
      const url = new URL(raw, origin);
      if (url.pathname.startsWith('/api/')) {
        const supplied = request.headers['x-difflearn-session'];
        if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new UiRequestError(403, 'Session header is missing or invalid; reopen the local viewer');
        const json = Buffer.from(JSON.stringify(project(url)));
        if (json.length > 4 * 1024 * 1024) throw new UiRequestError(413, 'Projection exceeds its byte bound; select a smaller page or export');
        response.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' }); response.end(json); return;
      }
      if (url.search) throw new UiRequestError(400, 'Static assets do not accept query parameters');
      const asset = staticAssets.get(url.pathname === '/' ? '/index.html' : url.pathname);
      if (!asset) throw new UiRequestError(404, 'No such bundled asset');
      let bytes = asset.bytes;
      if (asset.type.startsWith('text/html')) {
        const html = bytes.toString('utf8'); const marker = '<meta name="difflearn-bootstrap">';
        if (!html.includes(marker)) throw new UiRequestError(500, 'Production bootstrap is missing; rebuild the UI');
        bytes = Buffer.from(html.replace(marker, `<script id="difflearn-bootstrap" type="application/json" nonce="${nonce}">${JSON.stringify({ token }).replaceAll('<', '\\u003c')}</script>`));
      }
      response.writeHead(200, { 'Content-Type': asset.type }); response.end(bytes);
    } catch (failure) { error(failure instanceof UiRequestError ? failure.status : failure instanceof URIError ? 400 : 500, failure instanceof UiRequestError ? failure.message : 'Invalid viewer request'); }
  });
  server.maxHeadersCount = 32; server.keepAliveTimeout = 1000; server.timeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new ScanError('UI_START_FAILED', 'Cannot bind the loopback viewer', 1);
  host = `127.0.0.1:${address.port}`; origin = `http://${host}`;
  let resolveClosed: () => void; const done = new Promise<void>(resolve => { resolveClosed = resolve; });
  const close = async () => { if (closed) return done; closed = true; clearTimeout(expiration); options.signal?.removeEventListener('abort', aborted); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); resolveClosed(); };
  const aborted = () => { void close(); }; const expiration = setTimeout(aborted, lifetime); expiration.unref();
  options.signal?.addEventListener('abort', aborted, { once: true }); if (options.signal?.aborted) await close();
  return { url: `${origin}/`, done, close, schemaVersion: bundle.schemaVersion };
}
