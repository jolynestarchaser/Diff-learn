import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { startUi } from '../dist/ui/server.js';
import { readEvidenceBundle } from '../dist/evidence/read.js';

const proof = new URL('../.difflearn/ui-verification/', import.meta.url);
await mkdir(proof, { recursive: true });
const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const errors = [], servers = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
// Exercise the advertised selectable-text fallback without assuming clipboard permissions.
await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Synthetic clipboard denial'); } } }));
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to|violates.*directive/iu.test(message.text())) errors.push(message.text()); });
const fixture = async name => readEvidenceBundle(JSON.parse(await readFile(new URL(`../tests/fixtures/${name}.json`, import.meta.url), 'utf8')));
async function show(name) { const bundle = await fixture(name), server = await startUi(bundle); servers.push(server); await page.goto(server.url); await expect(page.getByText('Captured export · Read-only', { exact: true })).toBeVisible(); return { bundle, server }; }
async function service() { await page.getByRole('button', { name: 'synthetic-service' }).click(); await expect(page.locator('.file-list button').first()).toBeVisible(); }
async function file(name) { await page.locator('.file-list').getByRole('button', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click(); await expect(page.locator('.file-heading h2')).toHaveText(name); }
async function noOverflow() { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page must fit; source scrolls inside its own viewport'); }
try {
  const { bundle } = await show('ui/java');
  await page.getByRole('button', { name: 'Bionic Reading', exact: true }).focus(); await expect(page.getByRole('tooltip')).toContainText('original evidence stays unchanged'); await page.keyboard.press('Escape');
  await service(); await file('บริการ.java');
  const original = bundle.evidence.filter(entry => entry.kind === 'hunk' && entry.data.fileEvidenceId === bundle.evidence.find(entry => entry.kind === 'file-change' && entry.data.destinationPath === 'บริการ.java').id);
  await expect(page.locator('.hunk')).toHaveCount(original.length); assert.ok(original.length >= 2);
  await expect(page.locator('.uncollected-gap')).toBeVisible();
  const texts = await page.locator('.inline-code code').allTextContents(); assert.deepEqual(texts, original.flatMap(entry => entry.data.lines.map(line => line.content ?? '[Text encoding unavailable; see evidence bytes]')));
  assert.equal(await page.locator('.viewer img').count(), 0, 'Untrusted HTML source remains text');
  await expect(page.locator('.line-note').filter({ hasText: 'CRLF' }).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Split', exact: true }).click(); await expect(page.locator('.split-code')).toHaveCount(original.length);
  for (let index = 0; index < original.length; index++) {
    const rows = await page.locator('.split-code').nth(index).locator('.split-row').evaluateAll(nodes => nodes.map(row => [...row.querySelectorAll('.code-side')].map(side => ({ text: side.querySelector('code')?.textContent ?? null, number: side.querySelector('.line-number')?.textContent ?? '' }))));
    for (const [column, kind, coordinate] of [[0, 'add', 'oldLine'], [1, 'remove', 'newLine']]) assert.deepEqual(rows.map(row => row[column]).filter(side => side.text !== null), original[index].data.lines.filter(line => line.kind !== kind).map(line => ({ text: line.content, number: String(line[coordinate] ?? '') })));
  }
  await page.screenshot({ path: new URL('split.png', proof).pathname.replace(/^\/(?=[A-Z]:)/u, ''), fullPage: true });
  await page.getByRole('tab', { name: 'Inline', exact: true }).click();
  await page.getByRole('button', { name: 'Next hunk', exact: true }).click(); await expect(page.locator('.hunk.selected')).toHaveAttribute('id', `hunk-${original[1].id}`); await expect(page.locator('.symbol-list')).toContainText('ambiguous');
  await page.getByRole('button', { name: 'Copy selected evidence', exact: true }).click();
  await expect(page.getByLabel('Selectable handoff text')).toBeVisible(); const handoff = await page.getByLabel('Selectable handoff text').inputValue(); assert.ok(handoff.includes(original[1].id)); assert.ok(handoff.includes('"freshness": "not-verified"')); assert.ok(!handoff.includes('X-Difflearn-Session'));
  const copied = JSON.parse(handoff.slice(handoff.indexOf('\n') + 1)); assert.ok(copied.evidence.some(entry => entry.kind === 'file-change' && entry.id === original[1].data.fileEvidenceId)); assert.equal(copied.evidence.length, copied.relatedEvidence.retained + 1);
  // shadcn surfaces expose original data and manage modal/menu focus themselves.
  const record = page.getByRole('button', { name: 'Selected record and provenance', exact: true });
  await record.click(); const recordDialog = page.getByRole('dialog', { name: 'Selected record and provenance', exact: true });
  await expect(recordDialog).toBeVisible(); await expect(recordDialog.locator('pre')).toContainText(original[1].id);
  for (let index = 0; index < 5; index++) { await page.keyboard.press('Tab'); assert.ok(await recordDialog.evaluate(node => node.contains(document.activeElement)), 'Dialog traps keyboard focus'); }
  await page.screenshot({ path: new URL('shadcn-dialog.png', proof).pathname.replace(/^\/(?=[A-Z]:)/u, ''), fullPage: false });
  await page.keyboard.press('Escape'); await expect(recordDialog).not.toBeVisible(); await expect(record).toBeFocused();
  const actions = page.getByRole('button', { name: 'Evidence actions', exact: true });
  await actions.focus(); await page.keyboard.press('Space'); await expect(page.getByRole('menu')).toBeVisible(); await page.keyboard.press('Home'); await page.keyboard.press('Enter'); await expect(page.getByLabel('Selectable handoff text')).toHaveValue(handoff);
  await actions.click(); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await expect(recordDialog).toBeVisible(); await page.keyboard.press('Escape'); await expect(recordDialog).not.toBeVisible(); await expect(record).toBeFocused();
  const reading = page.getByRole('button', { name: 'Bionic Reading', exact: true });
  await expect(reading).toHaveAttribute('aria-pressed', 'false'); await reading.focus(); await page.keyboard.press('Space'); await expect(reading).toHaveAttribute('aria-pressed', 'true');
  const originalTexts = original.flatMap(entry => entry.data.lines.map(line => line.content ?? '[Text encoding unavailable; see evidence bytes]'));
  assert.deepEqual(await page.locator('.inline-code code').allTextContents(), originalTexts, 'Reading presentation retains every original source character');
  assert.ok(await page.locator('.inline-code .bionic-prefix').count() > 0);
  const emphasized = await page.locator('.inline-code .bionic-prefix').allTextContents(); assert.ok(emphasized.some(value => /[A-Za-z]/u.test(value))); assert.ok(emphasized.some(value => /\p{Script=Thai}/u.test(value)));
  await expect(page.locator('.syntax-policy')).toHaveText('Syntax only. No behavior, semantic callers or test coverage is proved.'); assert.ok(await page.locator('.syntax-policy .bionic-prefix').count() > 0);
  await page.getByRole('button', { name: 'Copy selected evidence', exact: true }).click(); await expect(page.getByLabel('Selectable handoff text')).toHaveValue(handoff);
  assert.equal(await page.locator('.viewer img').count(), 0);
  await page.screenshot({ path: new URL('bionic-english.png', proof).pathname.replace(/^\/(?=[A-Z]:)/u, ''), fullPage: true });
  await page.getByRole('tab', { name: 'Split', exact: true }).click();
  for (let index = 0; index < original.length; index++) for (const [column, excluded] of [[1, 'add'], [2, 'remove']]) assert.deepEqual(await page.locator('.split-code').nth(index).locator('.split-row .code-side:nth-child(' + column + ') code').allTextContents(), original[index].data.lines.filter(line => line.kind !== excluded).map(line => line.content));
  await page.getByRole('tab', { name: 'Inline', exact: true }).click(); await reading.click(); await expect(reading).toHaveAttribute('aria-pressed', 'false'); await expect(page.locator('.inline-code .bionic-prefix')).toHaveCount(0); assert.deepEqual(await page.locator('.inline-code code').allTextContents(), originalTexts);
  await reading.click();
  await page.getByLabel('Language', { exact: true }).selectOption('th'); await expect(page.locator('html')).toHaveAttribute('lang', 'th'); await expect(page.getByText('ยังไม่ได้ตรวจความสดของ working tree', { exact: true })).toBeVisible(); await noOverflow();
  await expect(page.locator('.syntax-policy')).toHaveText('ไวยากรณ์เท่านั้น ไม่พิสูจน์พฤติกรรม ผู้เรียกเชิงความหมาย หรือ test coverage'); assert.ok((await page.locator('.syntax-policy .bionic-prefix').allTextContents()).some(value => /\p{Script=Thai}/u.test(value))); await expect(reading).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: new URL('desktop-thai.png', proof).pathname.replace(/^\/(?=[A-Z]:)/u, ''), fullPage: true });
  await page.getByRole('button', { name: 'ธีมสว่าง', exact: true }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: new URL('light.png', proof).pathname.replace(/^\/(?=[A-Z]:)/u, ''), fullPage: true });
  for (const width of [1024, 768, 375]) { await page.setViewportSize({ width, height: 900 }); await noOverflow(); }
  await page.getByRole('button', { name: 'Repositories และไฟล์', exact: true }).click(); await expect(page.locator('#explorer')).toBeVisible();
  await file('Deleted.java'); await expect(page.locator('#explorer')).not.toBeVisible(); await expect(page.locator('.file-heading h2')).toBeFocused();
  await page.locator('.hunk-heading').first().click(); await expect(page.locator('#inspector')).toBeVisible(); await expect(page.locator('.symbol-list')).toContainText('before'); assert.ok(!(await page.locator('.symbol-list').innerText()).includes('/ after'));
  await page.screenshot({ path: new URL('mobile.png', proof).pathname.replace(/^\/(?=[A-Z]:)/u, ''), fullPage: false });
  await expect(page.getByRole('dialog', { name: 'ตรวจหลักฐาน', exact: true })).toBeVisible(); await noOverflow(); await page.keyboard.press('Escape'); await expect(page.locator('#inspector')).not.toBeVisible(); await expect(page.getByRole('button', { name: 'ตรวจหลักฐาน', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 }); await page.getByLabel('ภาษา', { exact: true }).selectOption('en');
  for (const [name, state] of [['image.bin', 'Binary file'], ['mode.txt', 'Mode-only change'], ['empty.txt', 'No collected text hunks']]) { await file(name); await expect(page.locator('.metadata-state h3')).toHaveText(state); await expect(page.locator('.hunk')).toHaveCount(0); }
  await file('unsupported.py'); await expect(page.locator('#inspector')).toContainText('SYMBOL_LANGUAGE_UNSUPPORTED');
  await file('Broken.java'); await expect(page.locator('#inspector')).toContainText('SYMBOL_SYNTAX_ERROR');
  await page.getByLabel('Filter paths', { exact: true }).fill('บริการ'); await expect(page.locator('.file-list button')).toHaveCount(1); await page.getByLabel('Filter paths', { exact: true }).fill('absent-fixture'); await expect(page.locator('.file-list button')).toHaveCount(0); await expect(page.locator('.viewer')).toContainText('Select retained evidence');
  await page.getByLabel('Filter paths', { exact: true }).fill(''); await page.getByLabel('Change type', { exact: true }).selectOption('D'); await expect(page.locator('.file-list button')).toHaveCount(1); await page.getByRole('button', { name: 'failed-peer' }).click(); await expect(page.locator('.viewer')).toContainText('Select retained evidence'); await expect(page.locator('.viewer')).not.toContainText('No changes in this comparison');
  await show('ui/partial'); await service(); await file('บริการ.java'); await expect(page.locator('.viewer')).toContainText('Patch coverage: partial'); await expect(page.locator('#inspector')).toContainText('SYMBOL_SOURCE_LIMIT');
  await show('ui/empty'); await expect(page.locator('.viewer')).toContainText('No changes in this comparison');
  for (const version of ['1.0.0', '1.1.0', '1.2.0']) { await show(`evidence/${version}`); await expect(page.locator('.capture')).toContainText(`Historical schema ${version}`); await expect(page.locator('.hunk').first()).toBeVisible(); await expect(page.locator('.selected-evidence')).toBeVisible(); }
  await page.goto('about:blank'); await page.goto(servers.at(-1).url); await expect(page.locator('.hunk').first()).toBeVisible(); await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to hunks', exact: true })).toBeFocused(); await page.keyboard.press('Enter'); await expect(page.locator('#viewer')).toBeFocused();
  await page.setViewportSize({ width: 375, height: 900 }); await page.goto('about:blank'); await page.goto(servers.at(-1).url); await expect(page.locator('.hunk').first()).toBeVisible(); await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to inspector', exact: true })).toBeFocused(); await page.keyboard.press('Enter'); await expect(page.locator('#inspector')).toBeVisible(); await expect(page.locator('#inspector')).toBeFocused(); await noOverflow();
  const fallback = await context.newPage(); await fallback.addInitScript(() => Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true })); await fallback.goto(servers[0].url); await expect(fallback.getByText('Captured export · Read-only', { exact: true })).toBeVisible(); await fallback.getByRole('button', { name: 'synthetic-service' }).click(); await fallback.locator('.file-list').getByRole('button', { name: /บริการ\.java/u }).click(); await expect(fallback.locator('.hunk').first()).toBeVisible(); await fallback.getByRole('button', { name: 'Bionic Reading', exact: true }).click(); await expect(fallback.locator('.inline-code .bionic-prefix')).toHaveCount(0); assert.deepEqual(await fallback.locator('.inline-code code').allTextContents(), originalTexts); await fallback.close();
  await page.route('**/api/state', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Session expired; reopen the local viewer' }) })); await page.reload(); await expect(page.getByRole('alert')).toContainText('Session expired'); await expect(page.locator('main')).toContainText('No snapshot available'); await page.unroute('**/api/state');
  // A real production UI remains visible while collection and generation-pinned page preparation run.
  let release, calls = 0;
  const live = await startUi(null, { local: { root: 'C:/synthetic repository ไทย', branch: 'main', collect: () => { calls++; return new Promise(resolve => { release = resolve; }); } } }); servers.push(live);
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(live.url);
  await expect(page.getByText('Collecting current changes…', { exact: true })).toBeVisible(); await expect(page.locator('.local-session')).toContainText('C:/synthetic repository ไทย'); await expect(page.locator('.local-session')).toContainText('Branch: main · all');
  await expect(page.getByRole('button', { name: 'Collecting…', exact: true })).toBeDisabled();
  release(await fixture('ui/java')); await expect(page.getByText('Local changes · Read-only', { exact: true })).toBeVisible(); await service(); await file('บริการ.java');
  await page.locator('.hunk-heading').nth(1).click(); await expect(page.locator('.hunk').nth(1)).toHaveClass(/selected/u);
  const selectedBefore = await page.locator('.selected-evidence code').textContent(); const displayBefore = await page.locator('.capture').textContent();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.getByRole('button', { name: 'Collecting…', exact: true })).toBeDisabled(); assert.equal(calls, 2);
  assert.equal(await page.locator('.capture').textContent(), displayBefore); await expect(page.locator('.file-heading h2')).toHaveText('บริการ.java');
  release(await fixture('ui/java')); await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled(); await expect(page.locator('.hunk').nth(1)).toHaveClass(/selected/u); assert.equal(await page.locator('.selected-evidence code').textContent(), selectedBefore);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); release({ schemaVersion: 'invalid' }); await expect(page.getByRole('alert')).toContainText('Correct the problem'); await expect(page.locator('.file-heading h2')).toHaveText('บริการ.java');
  await page.screenshot({ path: new URL('local-refresh.png', proof).pathname.replace(/^\/(?=[A-Z]:)/u, ''), fullPage: true });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); release(await fixture('ui/empty')); await expect(page.locator('.viewer')).toContainText('No changes in this comparison'); await expect(page.locator('.hunk')).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 900 }); await noOverflow(); await page.screenshot({ path: new URL('local-mobile.png', proof).pathname.replace(/^\/(?=[A-Z]:)/u, ''), fullPage: true });
  const head = 'a'.repeat(40), parent = 'b'.repeat(40), upstream = 'c'.repeat(40);
  let emptyOutgoing = false;
  const outgoing = await startUi(null, { local: { root: 'C:/synthetic repository ไทย', branch: 'main', collect: () => fixture('ui/java'), history: {
    capture: async (_signal, chosen) => ({ head, branch: 'main', detached: false, shallow: false, comparison: { ref: chosen ?? 'refs/remotes/fixture/main', oid: upstream, kind: chosen ? 'chosen' : 'upstream' }, refs: [{ ref: 'refs/heads/compare', oid: upstream }], upstreamRef: 'refs/remotes/fixture/main', status: emptyOutgoing ? 'empty' : 'ready', ahead: emptyOutgoing ? 0 : 1, behind: 1, diverged: !emptyOutgoing, commits: emptyOutgoing ? [] : [{ oid: head, shortOid: head.slice(0, 12), subject: 'merge ไทย <img src=x onerror=alert(1)>', author: 'Synthetic ไทย', date: '2026-10-05T12:00:00+07:00', parents: [parent, upstream], unavailableReason: null }], complete: true, omittedCommits: 0, mergeBases: [parent], aggregateReason: null, capturedAt: '2026-10-05T12:00:00+07:00' }),
    collect: async () => emptyOutgoing ? null : fixture('ui/java'),
  } } }); servers.push(outgoing);
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(outgoing.url); await expect(page.getByText('Local changes · Read-only', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Uncommitted changes', exact: true }).focus(); await page.keyboard.press('ArrowRight'); await expect(page.getByRole('tab', { name: 'Unpushed commits', exact: true })).toBeFocused(); await expect(page.getByRole('tab', { name: 'Uncommitted changes', exact: true })).toHaveAttribute('aria-selected', 'true'); await page.keyboard.press('Enter'); await expect(page.getByText('Commit changes · Read-only', { exact: true })).toBeVisible(); await expect(page.locator('.outgoing-panel')).toContainText('Diverged histories'); await expect(page.locator('.comparison-ref')).toContainText(upstream);
  await page.locator('.commit-list button').click(); await expect(page.locator('.selected-commit')).toContainText('First-parent comparison'); await expect(page.locator('.selected-commit')).toContainText(parent); await expect(page.locator('.selected-commit')).toContainText(upstream); assert.equal(await page.locator('.outgoing-panel img').count(), 0);
  await service(); await file('บริการ.java'); await page.getByRole('button', { name: 'Copy selected evidence', exact: true }).click(); const commitHandoff = await page.getByLabel('Selectable handoff text').inputValue(); assert.ok(commitHandoff.includes('"commitReview"')); assert.ok(commitHandoff.includes(head));
  await page.getByRole('button', { name: 'Aggregate outgoing changes', exact: true }).click(); await expect(page.locator('.selected-commit')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Aggregate outgoing changes', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const width of [1024, 768, 375]) { await page.setViewportSize({ width, height: 900 }); await noOverflow(); }
  await page.screenshot({ path: new URL('outgoing-mobile.png', proof).pathname.replace(/^\/(?=[A-Z]:)/u, ''), fullPage: true });
  emptyOutgoing = true; await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.locator('.outgoing-panel')).toContainText('No outgoing commits'); await expect(page.locator('.workspace')).toHaveCount(0); await expect(page.locator('.hunk')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Uncommitted changes', exact: true }).click(); await expect(page.getByText('Local changes · Read-only', { exact: true })).toBeVisible(); await expect(page.locator('.outgoing-panel')).toHaveCount(0);
  assert.deepEqual(errors, []); console.log('Browser verified: shadcn tabs, native forms, provenance Dialog with trapped/restored focus, keyboard Dropdown Menu, Tooltip and responsive Sheets/Escape, nonce-styled CSP without violations; production assets; both review modes, commit metadata/parents and untrusted subjects as text, aggregate distinction, captured upstream IDs, copy provenance, outgoing-empty atomic replacement; local loading/refresh/selection/error; original hunks/IDs, Thai/CRLF, existing reading/copy/fallback, split/inline, ambiguity/deletions/errors/partial/binary/mode/empty/historical, keyboard, themes, 1440/1024/768/375 px. Screenshots: .difflearn/ui-verification.');
} finally { await context.close(); await browser.close(); await Promise.all(servers.map(server => server.close())); }
