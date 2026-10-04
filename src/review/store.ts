import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ScanError } from '../config/load.js';
import { emptyReviewState, reviewLimits, validateReviewState, type ReviewState } from './schema.js';

const hasCode = (error: unknown, code: string) => error instanceof Error && 'code' in error && error.code === code;
export const reviewStateFile = (root: string) => path.join(root, '.difflearn', 'review-state.json');
export async function readBoundedJson(filename: string, limit: number, code: string): Promise<unknown> {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new ScanError(code, 'Expected a regular, non-symlink JSON file', 1);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (before.dev !== info.dev || before.ino !== info.ino || !before.isFile()) throw new ScanError(code, 'JSON file changed while opening it', 1);
    if (before.size > limit) throw new ScanError(code, `JSON file exceeds the ${limit}-byte limit`, 1);
    const buffer = Buffer.alloc(Math.min(limit + 1, before.size + 1)); let count = 0;
    while (count < buffer.length) { const result = await handle.read(buffer, count, buffer.length - count, null); if (!result.bytesRead) break; count += result.bytesRead; }
    const after = await handle.stat();
    if (count > limit || count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ScanError(code, 'JSON file changed or exceeded its bound during reading', 1);
    const bytes = buffer.subarray(0, count), text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new ScanError(code, 'JSON file must contain lossless UTF-8', 1);
    try { return JSON.parse(text) as unknown; } catch { throw new ScanError(code, 'JSON file is malformed; it was not treated as empty state', 1); }
  } finally { await handle.close(); }
}
async function stateDirectory(root: string, create: boolean): Promise<string | null> {
  const directory = path.join(root, '.difflearn');
  if (create) await mkdir(directory, { recursive: false }).catch(error => { if (!hasCode(error, 'EEXIST')) throw error; });
  let info;
  try { info = await lstat(directory); } catch (error) { if (!create && hasCode(error, 'ENOENT')) return null; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || path.relative(directory, await realpath(directory)) !== '') throw new ScanError('REVIEW_STATE_PATH', '.difflearn must be a real local directory, not a symlink or junction', 1);
  return directory;
}
export async function readReviewState(root: string): Promise<{ state: ReviewState; presence: 'absent' | 'loaded'; writePending: boolean }> {
  const directory = await stateDirectory(root, false);
  if (!directory) return { state: emptyReviewState(), presence: 'absent', writePending: false };
  let writePending = false;
  try { await lstat(path.join(directory, 'review-state.lock')); writePending = true; } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  try { return { state: validateReviewState(await readBoundedJson(reviewStateFile(root), reviewLimits.maxStateBytes, 'REVIEW_STATE_CORRUPT')), presence: 'loaded', writePending }; }
  catch (error) { if (hasCode(error, 'ENOENT')) return { state: emptyReviewState(), presence: 'absent', writePending }; throw error; }
}
type Update = (state: ReviewState, discarded: string | null) => ReviewState;
export async function mutateReviewState(root: string, update: Update, options: { resetInvalid?: boolean; signal?: AbortSignal; beforeReplace?: () => Promise<void> } = {}): Promise<{ state: ReviewState; discarded: string | null }> {
  const directory = await stateDirectory(root, true);
  const filename = reviewStateFile(root), lockname = path.join(directory!, 'review-state.lock');
  const temporary = path.join(directory!, `review-state.${randomUUID()}.tmp`);
  options.signal?.throwIfAborted();
  let lock;
  try { lock = await open(lockname, 'wx', 0o600); }
  catch (error) { if (hasCode(error, 'EEXIST')) throw new ScanError('REVIEW_STATE_BUSY', 'Review state lock exists. If its writer crashed, verify that no writer remains before manually removing .difflearn/review-state.lock; temporary files are never promoted', 1); throw error; }
  let wroteTemporary = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }), 'utf8');
    let state: ReviewState, discarded: string | null = null;
    try { state = (await readReviewState(root)).state; }
    catch (error) {
      if (!options.resetInvalid || !(error instanceof ScanError) || !['REVIEW_STATE_CORRUPT', 'REVIEW_STATE_VERSION'].includes(error.code)) throw error;
      discarded = error.code; state = emptyReviewState();
    }
    const next = validateReviewState(update(state, discarded));
    const content = `${JSON.stringify(next)}\n`;
    if (Buffer.byteLength(content) > reviewLimits.maxStateBytes) throw new ScanError('REVIEW_LIMIT', 'Review state exceeds its byte limit; no state was changed', 1);
    const handle = await open(temporary, 'wx', 0o600); wroteTemporary = true;
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    // Fault-injection checkpoint for real interrupted-writer integration fixtures.
    await options.beforeReplace?.();
    options.signal?.throwIfAborted();
    await stateDirectory(root, false);
    await rename(temporary, filename); wroteTemporary = false;
    // Windows does not expose portable directory fsync. Never delete the old file
    // to make replacement work: a failed rename leaves the previous state intact.
    if (process.platform !== 'win32') {
      const parent = await open(directory!, constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
    }
    return { state: next, discarded };
  } finally {
    try { if (wroteTemporary) await unlink(temporary); }
    finally { await lock.close(); await unlink(lockname); }
  }
}
