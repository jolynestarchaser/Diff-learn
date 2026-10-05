import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScanError } from '../config/load.js';
import { readEvidenceBundle } from '../evidence/read.js';
import { createUiProjection, UiRequestError } from './projection.js';
import type { UiAppState, UiSession, OutgoingReview, ReviewSelection } from './contracts.js';

type LocalCollection = { root: string; branch: string | null; collect: (signal: AbortSignal) => Promise<unknown>; history?: {
  capture: (signal: AbortSignal, chosenRef?: string) => Promise<OutgoingReview>;
  collect: (review: OutgoingReview, selection: ReviewSelection, signal: AbortSignal) => Promise<unknown | null>;
} };

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
export async function startUi(value: unknown, options: { signal?: AbortSignal; lifetimeMs?: number; local?: LocalCollection } = {}) {
  options.signal?.throwIfAborted();
  const bundle = options.local ? null : readEvidenceBundle(structuredClone(value)), staticAssets = await assets();
  const lifetime = options.lifetimeMs ?? 30 * 60_000;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 60 * 60_000) throw new ScanError('UI_SESSION_INVALID', 'Session lifetime exceeds its bound', 1);
  const token = randomBytes(32).toString('hex'), nonce = randomBytes(18).toString('base64');
  const expirationDate = options.local ? null : new Date(Date.now() + lifetime).toISOString();
  const projections = new Map<number, ReturnType<typeof createUiProjection>>();
  if (bundle) projections.set(1, createUiProjection(bundle, expirationDate));
  const initial = projections.get(1);
  let state: UiAppState = { mode: options.local ? 'repository' : 'export', phase: options.local ? 'loading' : 'ready', root: options.local?.root ?? '', branch: options.local?.branch ?? null, scope: options.local ? 'all' : bundle!.request.scopes.join(', '), generation: bundle ? 1 : 0, snapshot: initial ? initial(new URL('http://localhost/api/session')) as UiSession : null, error: null };
  if (options.local?.history) state = { ...state, reviewSelection: { mode: 'uncommitted', commit: null }, outgoing: null };
  const collectionController = new AbortController();
  let active: Promise<void> | null = null;
  const recollect = (requested = state.reviewSelection, refresh = true) => {
    if (active || !options.local || closed) return;
    state = { ...state, phase: state.snapshot ? 'refreshing' : 'loading', error: null };
    active = (async () => {
      try {
        let outgoing = state.outgoing ?? null;
        let selection = requested;
        if (options.local!.history) {
          if (refresh || !outgoing || selection?.comparisonRef !== state.reviewSelection?.comparisonRef) outgoing = await options.local!.history.capture(collectionController.signal, selection?.comparisonRef);
          if (selection?.commit && !outgoing?.commits.some(commit => commit.oid === selection!.commit)) selection = { ...selection, commit: null };
        }
        const value = selection?.mode === 'unpushed' && outgoing ? await options.local!.history!.collect(outgoing, selection, collectionController.signal) : await options.local!.collect(collectionController.signal);
        const collected = value === null ? null : readEvidenceBundle(structuredClone(value));
        collectionController.signal.throwIfAborted();
        const project = collected ? createUiProjection(collected, null) : null;
        // The branch comes from the collector's guarded revision, never from a later Git read.
        const head = collected?.repositories[0]?.revisions?.head;
        const branch = outgoing ? outgoing.branch : head ? head.branch : state.branch;
        const generation = state.generation + 1;
        const snapshot = project ? project(new URL('http://localhost/api/session')) as UiSession : null;
        if (project) projections.set(generation, project);
        for (const key of projections.keys()) if (key < generation - 1) projections.delete(key);
        state = { ...state, phase: 'ready', generation, snapshot, branch, scope: selection?.mode === 'unpushed' ? 'branch' : state.mode === 'repository' ? 'all' : state.scope, error: null, ...(selection ? { reviewSelection: selection, outgoing } : {}) };
      } catch (error) {
        if (!collectionController.signal.aborted) state = { ...state, phase: 'error', error: { code: error instanceof ScanError ? error.code : 'COLLECTION_FAILED', message: error instanceof Error ? error.message : 'Collection failed. Check the terminal, then refresh.' } };
      } finally { active = null; }
    })();
  };
  let origin = '', host = ''; let closed = false;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'`);
    const error = (status: number, message: string) => { response.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' }); response.end(JSON.stringify({ error: message })); };
    try {
      if (closed || request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== host || request.headers.origin !== undefined && request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') throw new UiRequestError(403, 'Only this same-origin loopback session is allowed');
      if (request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0') throw new UiRequestError(413, 'Request bodies are not accepted');
      const raw = request.url ?? ''; if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > 2048) throw new UiRequestError(400, 'Invalid or oversized request target');
      const decoded = decodeURIComponent(raw.split('?')[0]!);
      if (decoded.includes('\\') || decoded.split('/').some(part => part === '.' || part === '..')) throw new UiRequestError(400, 'Asset traversal is not accepted');
      const url = new URL(raw, origin);
      const refresh = url.pathname === '/api/refresh' && !!options.local;
      const review = url.pathname === '/api/review' && !!options.local?.history;
      if (request.method !== 'GET' && !((refresh || review) && request.method === 'POST')) throw new UiRequestError(405, 'Only read requests and explicit local review collection are supported');
      if (url.pathname.startsWith('/api/')) {
        const supplied = request.headers['x-difflearn-session'];
        if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new UiRequestError(403, 'Session header is missing or invalid; reopen the local viewer');
        let result: unknown;
        if (url.pathname === '/api/state') {
          if (url.search) throw new UiRequestError(400, 'State does not accept query parameters');
          result = state;
        } else if (refresh || review) {
          if (request.method !== 'POST') throw new UiRequestError(405, 'Refresh requires POST');
          if (request.headers.origin !== origin) throw new UiRequestError(403, 'Refresh requires this exact origin');
          if (refresh && url.search) throw new UiRequestError(400, 'Refresh does not accept query parameters');
          if (active) throw new UiRequestError(409, 'Collection is already running');
          if (review) {
            for (const key of url.searchParams.keys()) if (!['mode', 'commit', 'comparisonRef'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new UiRequestError(400, 'Invalid review selection');
            const mode = url.searchParams.get('mode'), commit = url.searchParams.get('commit'), comparisonRef = url.searchParams.get('comparisonRef') ?? state.reviewSelection?.comparisonRef;
            if (mode !== 'uncommitted' && mode !== 'unpushed' || mode === 'uncommitted' && commit !== null || commit !== null && !state.outgoing?.commits.some(item => item.oid === commit)) throw new UiRequestError(400, 'Select a captured outgoing commit or aggregate review');
            if (comparisonRef !== undefined && !state.outgoing?.refs.some(item => item.ref === comparisonRef)) throw new UiRequestError(400, 'Select an available captured local ref');
            recollect({ mode, commit, ...(comparisonRef !== undefined ? { comparisonRef } : {}) }, false);
          } else recollect(); result = state;
        } else {
          const generations = url.searchParams.getAll('generation');
          if (generations.length > 1 || generations[0] !== undefined && !/^[1-9][0-9]{0,9}$/u.test(generations[0])) throw new UiRequestError(400, 'Invalid snapshot generation');
          const generation = generations[0] === undefined ? state.generation : Number(generations[0]);
          const project = projections.get(generation);
          if (!project) throw new UiRequestError(409, 'This snapshot is unavailable; refresh the viewer');
          url.searchParams.delete('generation'); result = project(url);
        }
        const json = Buffer.from(JSON.stringify(result));
        if (json.length > 4 * 1024 * 1024) throw new UiRequestError(413, 'Projection exceeds its byte bound; select a smaller page or export');
        response.writeHead(refresh || review ? 202 : 200, { 'Content-Type': 'application/json;charset=utf-8' }); response.end(json); return;
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
  const close = async () => { if (closed) return done; closed = true; clearTimeout(expiration); collectionController.abort(); options.signal?.removeEventListener('abort', aborted); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await active; resolveClosed(); };
  const aborted = () => { void close(); }; const expiration = options.local ? undefined : setTimeout(aborted, lifetime); expiration?.unref();
  options.signal?.addEventListener('abort', aborted, { once: true }); if (options.signal?.aborted) await close();
  recollect();
  return { url: `${origin}/`, done, close, schemaVersion: bundle?.schemaVersion ?? null };
}
