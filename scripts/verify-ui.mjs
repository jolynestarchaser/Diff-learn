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
const fixture = async name => readEvidenceBundle(JSON.parse(await readFile(new URL(`../tests/fixtures/${name}.json`, import.meta.url), 'utf8')));
async function show(name) { const bundle = await fixture(name), server = await startUi(bundle); servers.push(server); await page.goto(server.url); await expect(page.getByText('Captured export · Read-only', { exact: true })).toBeVisible(); return { bundle, server }; }
async function service() { await page.getByRole('button', { name: 'synthetic-service' }).click(); await expect(page.locator('.file-list button').first()).toBeVisible(); }
async function file(name) { await page.locator('.file-list').getByRole('button', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click(); await expect(page.locator('.file-heading h2')).toHaveText(name); }
async function noOverflow() { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page must fit; source scrolls inside its own viewport'); }
try {
  const { bundle } = await show('ui/java'); await service(); await file('บริการ.java');
  const original = bundle.evidence.filter(entry => entry.kind === 'hunk' && entry.data.fileEvidenceId === bundle.evidence.find(entry => entry.kind === 'file-change' && entry.data.destinationPath === 'บริการ.java').id);
  await expect(page.locator('.hunk')).toHaveCount(original.length); assert.ok(original.length >= 2);
  await expect(page.locator('.uncollected-gap')).toBeVisible();
  const texts = await page.locator('.inline-code code').allTextContents(); assert.deepEqual(texts, original.flatMap(entry => entry.data.lines.map(line => line.content ?? '[Text encoding unavailable; see evidence bytes]')));
  assert.equal(await page.locator('.viewer img').count(), 0, 'Untrusted HTML source remains text');
  await expect(page.locator('.line-note').filter({ hasText: 'CRLF' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Split', exact: true }).click(); await expect(page.locator('.split-code')).toHaveCount(original.length);
  for (let index = 0; index < original.length; index++) {
    const rows = await page.locator('.split-code').nth(index).locator('.split-row').evaluateAll(nodes => nodes.map(row => [...row.querySelectorAll('.code-side')].map(side => ({ text: side.querySelector('code')?.textContent ?? null, number: side.querySelector('.line-number')?.textContent ?? '' }))));
    for (const [column, kind, coordinate] of [[0, 'add', 'oldLine'], [1, 'remove', 'newLine']]) assert.deepEqual(rows.map(row => row[column]).filter(side => side.text !== null), original[index].data.lines.filter(line => line.kind !== kind).map(line => ({ text: line.content, number: String(line[coordinate] ?? '') })));
  }
  await page.screenshot({ path: new URL('split.png', proof).pathname.replace(/^\/(?=[A-Z]:)/u, ''), fullPage: true });
  await page.getByRole('button', { name: 'Inline', exact: true }).click();
  await page.getByRole('button', { name: 'Next hunk', exact: true }).click(); await expect(page.locator('.hunk.selected')).toHaveAttribute('id', `hunk-${original[1].id}`); await expect(page.locator('.symbol-list')).toContainText('ambiguous');
  await page.getByRole('button', { name: 'Copy selected evidence', exact: true }).click();
  await expect(page.getByLabel('Selectable handoff text')).toBeVisible(); const handoff = await page.getByLabel('Selectable handoff text').inputValue(); assert.ok(handoff.includes(original[1].id)); assert.ok(handoff.includes('"freshness": "not-verified"')); assert.ok(!handoff.includes('X-Difflearn-Session'));
  const copied = JSON.parse(handoff.slice(handoff.indexOf('\n') + 1)); assert.ok(copied.evidence.some(entry => entry.kind === 'file-change' && entry.id === original[1].data.fileEvidenceId)); assert.equal(copied.evidence.length, copied.relatedEvidence.retained + 1);
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
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  for (let index = 0; index < original.length; index++) for (const [column, excluded] of [[1, 'add'], [2, 'remove']]) assert.deepEqual(await page.locator('.split-code').nth(index).locator('.split-row .code-side:nth-child(' + column + ') code').allTextContents(), original[index].data.lines.filter(line => line.kind !== excluded).map(line => line.content));
  await page.getByRole('button', { name: 'Inline', exact: true }).click(); await reading.click(); await expect(reading).toHaveAttribute('aria-pressed', 'false'); await expect(page.locator('.inline-code .bionic-prefix')).toHaveCount(0); assert.deepEqual(await page.locator('.inline-code code').allTextContents(), originalTexts);
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
  await page.screenshot({ path: new URL('mobile.png', proof).pathname.replace(/^\/(?=[A-Z]:)/u, ''), fullPage: true });
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
  await page.route('**/api/session', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Session expired; reopen the local viewer' }) })); await page.reload(); await expect(page.getByRole('alert')).toContainText('Session expired'); await expect(page.locator('main')).toContainText('dr ui --evidence');
  assert.deepEqual(errors, []); console.log('Browser verified: installed Edge production assets; original hunks/IDs, Thai/CRLF, bilingual Bionic Reading toggle/graphemes/copy/fallback, split/inline, ambiguity/deletions/errors/partial/binary/mode/empty/historical, read-only handoff fallback, keyboard, dark/light, 1440/1024/768/375 px. Screenshots: .difflearn/ui-verification.');
} finally { await context.close(); await browser.close(); await Promise.all(servers.map(server => server.close())); }
