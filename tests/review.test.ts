import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { z } from 'zod';
import { resolveLimits } from '../src/config/schema.js';
import { canonicalRoot, discover } from '../src/git/discovery.js';
import { collectRepository } from '../src/git/collector.js';
import { patchOptions, type Scope } from '../src/git/adapter.js';
import { buildBundle } from '../src/evidence/bundle.js';
import { validateBundle, type EvidenceBundle } from '../src/evidence/schema.js';
import { extendSyntaxBundle } from '../src/evidence/syntax.js';
import { renderContext } from '../src/output/context.js';
import { listReview, markReview, contentFingerprint } from '../src/review/matching.js';
import { acknowledgmentId, emptyReviewState, reviewStateSchema, reviewOutputSchema, validateReviewState } from '../src/review/schema.js';
import { readReviewState, mutateReviewState, reviewStateFile, readBoundedJson } from '../src/review/store.js';

const cliPath = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const limits = resolveLimits(undefined), filename = 'sample ไทย with spaces.txt';
const baseline = Array.from({ length: 48 }, (_, index) => `unique line ${index}`);
const source = (lines: string[]) => `${lines.join('\n')}\n`;
function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', ...args], { cwd, env, shell: false, timeout: 30_000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr.toString()); return result.stdout;
}
async function fixture(fn: (root: string, temporary: string) => Promise<void>) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'difflearn-review-')); const root = path.join(temporary, 'workspace ไทย'); await mkdir(root);
  try { await fn(await canonicalRoot(root), temporary); } finally { const relative = path.relative(os.tmpdir(), temporary); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await rm(temporary, { recursive: true, force: true }); }
}
async function init(root: string, text = source(baseline)) {
  git(root, 'init', '-b', 'main'); git(root, 'config', 'core.autocrlf', 'false'); git(root, 'config', 'core.hooksPath', '.git/no-fixture-hooks');
  await writeFile(path.join(root, '.git', 'fixture-ignore'), ''); await writeFile(path.join(root, '.git', 'fixture-attributes'), ''); git(root, 'config', 'core.excludesFile', '.git/fixture-ignore'); git(root, 'config', 'core.attributesFile', '.git/fixture-attributes');
  await writeFile(path.join(root, filename), text); git(root, 'add', '--', filename); git(root, 'commit', '-m', 'synthetic baseline'); git(root, 'branch', 'base');
}
async function collected(root: string, scope: Scope = 'all', base = 'base', maxPatchBytes?: number) {
  const config = { configVersion: '1' as const }, actual = await canonicalRoot(root), quota = maxPatchBytes === undefined ? limits : { ...limits, maxPatchBytes };
  const found = await discover(actual, config, quota); const repositories = [];
  for (const repo of found.repositories) repositories.push(await collectRepository(repo, config, quota, { workspaceBytes: 0 }, base, undefined, undefined, { scope, includeUntracked: false }));
  const time = '2026-10-04T00:00:00.000Z';
  const input = { collector: { name: 'difflearn', version: 'fixture', gitVersion: 'fixture' }, collection: { startedAt: time, endedAt: time }, request: { root: actual, configPath: null, repositories: [], base, scopes: [scope], contentPolicy: 'metadata-only', comparisonOptions: patchOptions, immutableAttributeSource: 'captured-head', limits: quota }, discovery: found.discovery, repositories, diagnostics: repositories.flatMap(repo => repo.diagnostics), discoveryCompleteness: found.completeness };
  return { bundle: buildBundle(input), input };
}
const hunks = (bundle: EvidenceBundle) => bundle.evidence.filter(entry => entry.kind === 'hunk');
function mark(bundle: EvidenceBundle, id = hunks(bundle)[0]!.id) { const hunk = hunks(bundle).find(hunk => hunk.id === id)!; return markReview(bundle, emptyReviewState(), hunk.snapshotId, [id]); }
function cli(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, 'review', ...args, '--root', root], { encoding: 'utf8', shell: false, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }); assert.ifError(result.error); return result;
}
const report = (result: ReturnType<typeof cli>) => { assert.equal(result.stdout.trim().split('\n').length, 1); return reviewOutputSchema.parse(JSON.parse(result.stdout)); };

test('explicit CLI mark/list/reset cite concrete snapshots; context and list never create or mutate review state', async () => fixture(async (root, temporary) => {
  await init(root); const edited = [...baseline]; edited[12] = 'reviewed change'; await writeFile(path.join(root, filename), source(edited));
  const { bundle } = await collected(root), hunk = hunks(bundle)[0]!, exported = path.join(temporary, 'evidence.json'); await writeFile(exported, JSON.stringify(bundle));
  const before = cli(root, 'list', '--evidence', exported, '--json'); assert.equal(before.status, 0, before.stderr); const unseen = report(before); assert.equal(unseen.reportKind, 'review'); if (unseen.reportKind === 'review') { assert.equal(unseen.statePresence, 'absent'); assert.equal(unseen.rows[0]!.status, 'unseen'); }
  await assert.rejects(readFile(reviewStateFile(root)), { code: 'ENOENT' });
  renderContext(bundle, 'en'); await assert.rejects(readFile(reviewStateFile(root)), { code: 'ENOENT' });
  const wrong = cli(root, 'mark', '--evidence', exported, '--snapshot', 'f'.repeat(64), '--hunk', hunk.id, '--json'); assert.equal(wrong.status, 2); assert.equal(report(wrong).reportKind, 'error'); await assert.rejects(readFile(reviewStateFile(root)), { code: 'ENOENT' });
  const result = cli(root, 'mark', '--evidence', exported, '--snapshot', hunk.snapshotId, '--hunk', hunk.id, '--json'); assert.equal(result.status, 0, result.stderr); const marked = report(result); assert.equal(marked.reportKind, 'review'); if (marked.reportKind === 'review') { assert.equal(marked.rows[0]!.status, 'reviewed'); assert.equal(marked.rows[0]!.acknowledgment!.snapshotId, hunk.snapshotId); assert.deepEqual(marked.markedHunkEvidenceIds, [hunk.id]); }
  const bytes = await readFile(reviewStateFile(root)); assert.equal(bytes.toString().includes('2026-'), false); assert.equal(bytes.toString().includes('oldStart'), false);
  const listing = cli(root, 'list', '--evidence', exported, '--lang', 'th'); assert.equal(listing.status, 0, listing.stderr); assert.match(listing.stdout, /ตรวจทานแล้ว/u); assert.ok(listing.stdout.includes(filename)); assert.ok(listing.stdout.includes(hunk.id));
  const context = spawnSync(process.execPath, [cliPath, 'context', '--root', root, '--base', 'base', '--scope', 'all'], { encoding: 'utf8', shell: false, timeout: 90_000 }); assert.equal(context.status, 0, context.stderr); assert.deepEqual(await readFile(reviewStateFile(root)), bytes);
  const reset = cli(root, 'reset', '--json'); assert.equal(reset.status, 0, reset.stderr); const cleared = report(reset); if (cleared.reportKind === 'review') assert.equal(cleared.removedAcknowledgments, 1); assert.equal((await readReviewState(root)).state.acknowledgments.length, 0);
  const rootMismatch = cli(temporary, 'list', '--evidence', exported, '--json'); assert.equal(rootMismatch.status, 2); assert.match(rootMismatch.stderr, /REVIEW_ROOT_MISMATCH/);
  for (const args of [['mark', '--evidence', exported, '--snapshot', hunk.snapshotId], ['list', '--evidence', exported, '--lang', 'xx'], ['reset', '--json', '--json']]) { const invalid = cli(root, ...args, '--json'); assert.equal(invalid.status, 2); report(invalid); }
}));

test('unchanged content survives line shifts; a unique immutable before region establishes changed-since-reviewed', async () => fixture(async root => {
  await init(root); const edited = [...baseline]; edited[12] = 'reviewed change'; await writeFile(path.join(root, filename), source(edited));
  const original = (await collected(root)).bundle, state = mark(original), originalHunk = hunks(original)[0]!;
  assert.equal(listReview(original, state)[0]!.status, 'reviewed'); assert.deepEqual(markReview(original, state, originalHunk.snapshotId, [originalHunk.id]), state);
  await writeFile(path.join(root, filename), source(['prefix A', 'prefix B', 'prefix C', 'prefix D', 'prefix E', ...edited]));
  const shifted = (await collected(root)).bundle, shiftedHunk = hunks(shifted).find(hunk => contentFingerprint(hunk) === contentFingerprint(originalHunk))!;
  assert.ok(shiftedHunk); assert.notEqual(shiftedHunk.id, originalHunk.id); assert.notEqual(shiftedHunk.data.newStart, originalHunk.data.newStart);
  const shiftedRow = listReview(shifted, state).find(row => row.hunkEvidenceId === shiftedHunk.id)!; assert.equal(shiftedRow.status, 'reviewed'); assert.equal(shiftedRow.acknowledgment!.snapshotId, originalHunk.snapshotId);
  edited[12] = 'content edited after review'; await writeFile(path.join(root, filename), source(['prefix A', 'prefix B', 'prefix C', 'prefix D', 'prefix E', ...edited]));
  const changed = (await collected(root)).bundle, row = listReview(changed, state).find(row => row.status === 'changed-since-reviewed')!; assert.ok(row); assert.equal(row.reason, 'BEFORE_REGION_CONTINUITY');
  const refreshed = markReview(changed, state, row.snapshotId, [row.hunkEvidenceId]); assert.equal(refreshed.acknowledgments.length, 1); assert.equal(listReview(changed, refreshed).find(item => item.hunkEvidenceId === row.hunkEvidenceId)!.status, 'reviewed');
  const relocated = structuredClone(changed); relocated.request.root = 'X:/relocated'; relocated.collection.startedAt = relocated.collection.endedAt = '2030-01-01T00:00:00.000Z'; assert.deepEqual(listReview(relocated, refreshed), listReview(changed, refreshed));
}));

test('repeated identical hunks and competing acknowledgments remain unseen and cannot be implicitly marked', async () => fixture(async root => {
  const block = ['a', 'b', 'c', 'old', 'd', 'e', 'f', 'spacer', 'spacer', 'spacer', 'spacer']; await init(root, source([...block, ...block]));
  const changed = [...block, ...block]; changed[3] = changed[14] = 'new'; await writeFile(path.join(root, filename), source(changed));
  const bundle = (await collected(root)).bundle; assert.equal(hunks(bundle).length, 2); assert.equal(contentFingerprint(hunks(bundle)[0]!), contentFingerprint(hunks(bundle)[1]!));
  assert.ok(listReview(bundle, emptyReviewState()).every(row => row.status === 'unseen' && row.reason === 'AMBIGUOUS_HUNKS'));
  assert.throws(() => mark(bundle), { code: 'REVIEW_TARGET_AMBIGUOUS' });
  // First export has one changed occurrence; introducing an identical second
  // occurrence cannot transfer that previously unique acknowledgment.
  changed[14] = 'old'; await writeFile(path.join(root, filename), source(changed)); const single = (await collected(root)).bundle, state = mark(single);
  changed[3] = 'old'; changed[14] = 'new'; await writeFile(path.join(root, filename), source(changed)); const movedSingle = (await collected(root)).bundle;
  assert.equal(hunks(movedSingle).length, 1); assert.equal(contentFingerprint(hunks(single)[0]!), contentFingerprint(hunks(movedSingle)[0]!)); assert.equal(listReview(movedSingle, state)[0]!.status, 'unseen');
  changed[3] = 'new';
  changed[14] = 'new'; await writeFile(path.join(root, filename), source(changed)); const repeated = (await collected(root)).bundle; assert.ok(listReview(repeated, state).every(row => row.status === 'unseen'));
  const entry = state.acknowledgments[0]!, { id: _id, ...other } = { ...entry, snapshotId: 'b'.repeat(64), hunkEvidenceId: 'c'.repeat(64) };
  const competing = validateReviewState({ ...state, acknowledgments: [entry, { ...other, id: acknowledgmentId(other) }] }); assert.equal(listReview(single, competing)[0]!.reason, 'AMBIGUOUS_HUNKS');
}));

test('Git rename metadata can establish continuity; delete/add guesses and changed before blobs cannot', async () => fixture(async root => {
  await init(root); const edited = [...baseline]; edited[12] = 'reviewed change'; await writeFile(path.join(root, filename), source(edited)); git(root, 'add', '--', filename);
  const initial = (await collected(root, 'staged')).bundle, state = mark(initial), renamed = 'renamed ไทย.txt'; git(root, 'mv', '--', filename, renamed);
  const moved = (await collected(root, 'staged')).bundle; const file = moved.evidence.find(entry => entry.kind === 'file-change')!; assert.equal(file.kind, 'file-change'); if (file.kind === 'file-change') assert.equal(file.data.status, 'R'); assert.equal(listReview(moved, state)[0]!.status, 'reviewed');
  git(root, 'reset', '--hard', 'HEAD'); await writeFile(path.join(root, renamed), 'entirely different file\n'); git(root, 'rm', '--', filename); git(root, 'add', '--', renamed);
  const replaced = (await collected(root, 'staged')).bundle; assert.ok(listReview(replaced, state).every(row => row.status === 'unseen'));
  git(root, 'reset', '--hard', 'HEAD'); await writeFile(path.join(root, filename), source(edited)); const unstaged = (await collected(root, 'unstaged')).bundle, unstagedState = mark(unstaged);
  const nextBefore = [...baseline]; nextBefore[0] = 'new index baseline'; await writeFile(path.join(root, filename), source(nextBefore)); git(root, 'add', '--', filename); nextBefore[12] = 'reviewed change'; await writeFile(path.join(root, filename), source(nextBefore));
  const indexMoved = (await collected(root, 'unstaged')).bundle; assert.ok(listReview(indexMoved, unstagedState).every(row => row.status === 'unseen'));
}));

test('branches, detached commits, base inputs/commits and comparison scopes isolate review contexts', async () => fixture(async root => {
  await init(root); const edited = [...baseline]; edited[12] = 'reviewed change'; await writeFile(path.join(root, filename), source(edited)); git(root, 'add', '--', filename);
  const initial = (await collected(root, 'all')).bundle, state = mark(initial);
  const head = git(root, 'rev-parse', 'HEAD').toString().trim(), tree = git(root, 'rev-parse', 'HEAD^{tree}').toString().trim();
  const futureBase = git(root, 'commit-tree', tree, '-p', head, '-m', 'synthetic base-only advance').toString().trim(); git(root, 'branch', '-f', 'base', futureBase);
  const differentBaseCommit = (await collected(root)).bundle; assert.equal(differentBaseCommit.repositories[0]!.revisions!.head.oid, initial.repositories[0]!.revisions!.head.oid); assert.equal(differentBaseCommit.repositories[0]!.revisions!.mergeBase.oid, initial.repositories[0]!.revisions!.mergeBase.oid); assert.notEqual(differentBaseCommit.repositories[0]!.revisions!.base.oid, initial.repositories[0]!.revisions!.base.oid); assert.ok(listReview(differentBaseCommit, state).every(row => row.status === 'unseen')); git(root, 'branch', '-f', 'base', head);
  const sameOidBase = (await collected(root, 'all', git(root, 'rev-parse', 'base').toString().trim())).bundle; assert.ok(listReview(sameOidBase, state).every(row => row.status === 'unseen'));
  for (const scope of ['staged', 'unstaged', 'branch'] as const) {
    if (scope === 'unstaged') await writeFile(path.join(root, filename), source(edited.map((line, index) => index === 32 ? 'unstaged change' : line)));
    if (scope === 'branch') { git(root, 'add', '--', filename); git(root, 'commit', '-m', 'committed synthetic changes'); }
    const bundle = (await collected(root, scope)).bundle; assert.ok(hunks(bundle).length); assert.ok(listReview(bundle, state).every(row => row.status === 'unseen'));
  }
  const sameBranch = (await collected(root)).bundle, sameBranchState = mark(sameBranch); git(root, 'checkout', '-b', 'other'); const other = (await collected(root)).bundle; assert.ok(listReview(other, sameBranchState).every(row => row.status === 'unseen'));
  git(root, 'checkout', '--detach'); const detached = (await collected(root)).bundle, detachedState = mark(detached); assert.ok(listReview(detached, sameBranchState).every(row => row.status === 'unseen'));
  git(root, 'commit', '--allow-empty', '-m', 'different detached commit'); assert.ok(listReview((await collected(root)).bundle, detachedState).every(row => row.status === 'unseen'));
  git(root, 'branch', '-f', 'base', 'HEAD'); await writeFile(path.join(root, filename), source(edited.map((line, index) => index === 12 ? 'new base change' : line))); assert.ok(listReview((await collected(root)).bundle, state).every(row => row.status === 'unseen'));
}));

test('distinct linked worktrees stay isolated even with the same detached commit and byte-identical hunks', async () => fixture(async (root, temporary) => {
  const first = path.join(root, 'first'), second = path.join(root, 'second'); await mkdir(first); await init(first);
  git(first, 'worktree', 'add', '--detach', second, 'HEAD'); git(first, 'checkout', '--detach');
  const edited = [...baseline]; edited[12] = 'identical worktree change'; await writeFile(path.join(first, filename), source(edited)); await writeFile(path.join(second, filename), source(edited));
  const bundle = (await collected(root)).bundle, firstHunk = hunks(bundle).find(hunk => bundle.repositories.find(repo => repo.repositoryId === hunk.repositoryId)?.path === 'first')!;
  assert.equal(bundle.repositories.length, 2); const state = mark(bundle, firstHunk.id), rows = listReview(bundle, state); assert.equal(rows.filter(row => row.status === 'reviewed').length, 1); assert.equal(rows.filter(row => row.status === 'unseen').length, 1); assert.notEqual(rows[0]!.repositoryId, rows[1]!.repositoryId);
  assert.equal((await readReviewState(temporary)).presence, 'absent');
}));

test('new-file edits without a before region become unseen; truncated/failed evidence remains observable', async () => fixture(async (root, temporary) => {
  await init(root); await writeFile(path.join(root, 'new.ts'), 'export const added = 1;\n'); git(root, 'add', '--', 'new.ts'); const first = (await collected(root, 'staged')).bundle, state = mark(first);
  await writeFile(path.join(root, 'new.ts'), 'export const added = 2;\n'); git(root, 'add', '--', 'new.ts'); const edited = (await collected(root, 'staged')).bundle; assert.equal(listReview(edited, state)[0]!.status, 'unseen');
  const truncated = (await collected(root, 'staged', 'base', 30)).bundle, exported = path.join(temporary, 'partial.json'); assert.equal(truncated.completeness.state, 'partial'); await writeFile(exported, JSON.stringify(truncated)); const output = cli(root, 'list', '--evidence', exported, '--json'); assert.equal(output.status, 1, output.stderr); const partial = report(output); if (partial.reportKind === 'review') { assert.equal(partial.completeness.state, 'partial'); assert.equal(partial.inputCompleteness, 'partial'); } assert.match(output.stderr, /REVIEW_EVIDENCE_PARTIAL/);
  const failed = (await collected(root, 'all', 'missing')).bundle; await writeFile(exported, JSON.stringify(failed)); assert.equal(cli(root, 'list', '--evidence', exported, '--json').status, 1);
  await writeFile(path.join(root, 'syntax.ts'), 'export const item = 1;\n'); git(root, 'add', '--', 'syntax.ts');
  const withSyntax = await collected(root, 'staged'); const syntax = extendSyntaxBundle(withSyntax.bundle, withSyntax.input.repositories); await writeFile(exported, JSON.stringify(syntax)); const syntaxList = cli(root, 'list', '--evidence', exported, '--json'); assert.equal(syntaxList.status, 1); const syntaxReport = report(syntaxList); assert.equal(syntaxReport.reportKind, 'review'); if (syntaxReport.reportKind === 'review') assert.ok(syntaxReport.rows.length > 0);
}));

test('corrupt/incompatible state is never silently empty; explicit reset reports discarded state and schema validation detects tampering', async () => fixture(async (root, temporary) => {
  await init(root); const edited = [...baseline]; edited[12] = 'reviewed change'; await writeFile(path.join(root, filename), source(edited)); const bundle = (await collected(root)).bundle, exported = path.join(temporary, 'evidence.json'); await writeFile(exported, JSON.stringify(bundle));
  const state = mark(bundle); await mutateReviewState(root, () => state); const original = await readFile(reviewStateFile(root));
  for (const corrupt of ['{broken', JSON.stringify({ ...state, schemaVersion: '99.0.0' }), JSON.stringify({ ...state, acknowledgments: [{ ...state.acknowledgments[0], id: '0'.repeat(64) }] })]) {
    await writeFile(reviewStateFile(root), corrupt); const result = cli(root, 'list', '--evidence', exported, '--json'); assert.equal(result.status, 1); assert.equal(report(result).reportKind, 'error'); assert.match(result.stderr, /REVIEW_STATE_(CORRUPT|VERSION)/); assert.equal(await readFile(reviewStateFile(root), 'utf8'), corrupt);
    const target = hunks(bundle)[0]!, markResult = cli(root, 'mark', '--evidence', exported, '--snapshot', target.snapshotId, '--hunk', target.id, '--json'); assert.equal(markResult.status, 1); assert.equal(await readFile(reviewStateFile(root), 'utf8'), corrupt);
    const reset = cli(root, 'reset', '--json'); assert.equal(reset.status, 0, reset.stderr); const cleared = report(reset); if (cleared.reportKind === 'review') { assert.equal(cleared.removedAcknowledgments, null); assert.ok(cleared.diagnostics.length); } assert.equal((await readReviewState(root)).state.acknowledgments.length, 0);
  }
  await writeFile(reviewStateFile(root), original); validateReviewState(await readBoundedJson(reviewStateFile(root), 16 * 1024 * 1024, 'REVIEW_STATE_CORRUPT'));
  assert.throws(() => validateReviewState({ ...state, unexpected: true }), { code: 'REVIEW_STATE_CORRUPT' }); assert.throws(() => validateReviewState({ ...state, acknowledgments: [state.acknowledgments[0], state.acknowledgments[0]] }), { code: 'REVIEW_STATE_CORRUPT' });
  const tampered = structuredClone(bundle); hunks(tampered)[0]!.id = '0'.repeat(64); await writeFile(exported, JSON.stringify(tampered)); const badEvidence = cli(root, 'list', '--evidence', exported, '--json'); assert.equal(badEvidence.status, 2); report(badEvidence); assert.deepEqual(await readFile(reviewStateFile(root)), original);
}));

test('atomic writes preserve prior state on failure/abort; concurrent writers and actual killed writers cannot promote temporary files', async () => fixture(async (root, temporary) => {
  await init(root); const edited = [...baseline]; edited[12] = 'reviewed change'; await writeFile(path.join(root, filename), source(edited)); const bundle = (await collected(root)).bundle, state = mark(bundle); await mutateReviewState(root, () => state); const original = await readFile(reviewStateFile(root));
  const controller = new AbortController(); await assert.rejects(mutateReviewState(root, () => emptyReviewState(), { signal: controller.signal, beforeReplace: async () => { controller.abort(); } }), { name: 'AbortError' }); assert.deepEqual(await readFile(reviewStateFile(root)), original); assert.deepEqual((await readdir(path.dirname(reviewStateFile(root)))).sort(), ['review-state.json']);
  await assert.rejects(mutateReviewState(root, () => emptyReviewState(), { beforeReplace: async () => { throw new Error('synthetic interrupted write'); } }), /synthetic interrupted write/); assert.deepEqual(await readFile(reviewStateFile(root)), original);
  await mutateReviewState(root, current => current, { beforeReplace: async () => { await assert.rejects(mutateReviewState(root, () => emptyReviewState()), { code: 'REVIEW_STATE_BUSY' }); } }); assert.deepEqual(await readFile(reviewStateFile(root)), original);
  const storeUrl = pathToFileURL(fileURLToPath(new URL('../../dist/review/store.js', import.meta.url))).href, schemaUrl = pathToFileURL(fileURLToPath(new URL('../../dist/review/schema.js', import.meta.url))).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { mutateReviewState } from ${JSON.stringify(storeUrl)}; import { emptyReviewState } from ${JSON.stringify(schemaUrl)}; await mutateReviewState(process.argv[1], () => emptyReviewState(), { beforeReplace: async () => { process.stdout.write('ready\\n'); await new Promise(() => { setInterval(() => {}, 1000); }); } });`, root], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
  // Hold the child event loop open at the pre-rename checkpoint and kill it.
  const ready = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Interrupted writer did not reach checkpoint: ${stderr}`)), 15_000); child.stdout.once('data', chunk => { clearTimeout(timer); assert.match(String(chunk), /ready/); resolve(); }); child.once('error', reject); });
  await ready; assert.equal(child.kill('SIGKILL'), true); await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()); });
  assert.deepEqual(await readFile(reviewStateFile(root)), original); assert.deepEqual((await readReviewState(root)).state, state); assert.ok((await readdir(path.dirname(reviewStateFile(root)))).some(name => name.endsWith('.tmp')));
  assert.equal((await readReviewState(root)).writePending, true);
  const exported = path.join(temporary, 'evidence.json'); await writeFile(exported, JSON.stringify(bundle)); const pending = cli(root, 'list', '--evidence', exported, '--json'); assert.equal(pending.status, 1, pending.stderr); const pendingReport = report(pending); if (pendingReport.reportKind === 'review') { assert.equal(pendingReport.rows[0]!.status, 'reviewed'); assert.ok(pendingReport.completeness.reasons.includes('REVIEW_STATE_LOCK_PRESENT')); } assert.match(pending.stderr, /REVIEW_STATE_LOCK_PRESENT/);
  await assert.rejects(mutateReviewState(root, () => emptyReviewState(), { resetInvalid: true }), { code: 'REVIEW_STATE_BUSY' });
  // Fixture operator establishes that its child is dead before removing its lock.
  await rm(path.join(root, '.difflearn', 'review-state.lock')); await mutateReviewState(root, () => emptyReviewState()); assert.equal((await readReviewState(root)).state.acknowledgments.length, 0);
  assert.ok(path.relative(temporary, root));
}));

test('state directories cannot follow symlinks/junctions outside the workspace; published schemas match runtime contracts', async () => fixture(async (root, temporary) => {
  const outside = path.join(temporary, 'outside'); await mkdir(outside); await symlink(outside, path.join(root, '.difflearn'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readReviewState(root), { code: 'REVIEW_STATE_PATH' }); await assert.rejects(mutateReviewState(root, () => emptyReviewState()), { code: 'REVIEW_STATE_PATH' }); assert.deepEqual(await readdir(outside), []);
  for (const [filename, schema] of [['review-state.schema.json', reviewStateSchema], ['review-output.schema.json', reviewOutputSchema]] as const) { const published = JSON.parse(await readFile(new URL(`../../docs/${filename}`, import.meta.url), 'utf8')); assert.deepEqual(published, z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })); }
}));
