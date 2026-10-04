import { ScanError } from '../config/load.js';

export type GitPath = { path: string | null; pathBytes: string };
export type IndexEntry = GitPath & { mode: string; oid: string; stage: number };
export type FileChange = {
  originalPath: string | null; destinationPath: string | null;
  originalPathBytes: string; destinationPathBytes: string;
  status: string; similarity: number | null; oldMode: string; newMode: string;
  oldOid: string | null; newOid: string | null;
  kind: 'file' | 'symlink' | 'gitlink'; binary: boolean; added: number | null; deleted: number | null;
};
export type StatusEntry = GitPath & { kind: 'ordinary' | 'rename' | 'conflict'; xy: string; submodule: string; originalPath: string | null; originalPathBytes: string | null };
export type WorkingStatus = { available: boolean; clean: boolean | null; entries: StatusEntry[]; untracked: GitPath[]; headers: Record<string, string>; reasons: string[] };

export function text(bytes: Buffer): string {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value).equals(bytes)) throw new ScanError('UNSUPPORTED_PATH_ENCODING', 'Non-UTF-8 Git metadata cannot be used as an input path', 1);
  return value;
}
export function gitPath(bytes: Buffer): GitPath {
  const value = bytes.toString('utf8');
  return { path: Buffer.from(value).equals(bytes) ? value : null, pathBytes: bytes.toString('base64') };
}
export function nulRecords(bytes: Buffer): Buffer[] {
  if (bytes.length && bytes.at(-1) !== 0) throw new ScanError('METADATA_INVALID', 'Git NUL metadata is truncated', 1);
  const records: Buffer[] = []; let start = 0;
  for (let end = 0; end < bytes.length; end++) if (bytes[end] === 0) { records.push(bytes.subarray(start, end)); start = end + 1; }
  return records;
}
function invalid(): never { throw new ScanError('METADATA_INVALID', 'Git metadata does not match the documented machine format', 1); }
export function parseIndex(bytes: Buffer): IndexEntry[] {
  return nulRecords(bytes).map(record => {
    const tab = record.indexOf(9); const match = /^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])$/u.exec(record.subarray(0, tab).toString('ascii'));
    if (tab < 0 || !match) invalid();
    return { ...gitPath(record.subarray(tab + 1)), mode: match[1]!, oid: match[2]!, stage: Number(match[3]) };
  });
}
function fields(record: Buffer, count: number): { values: string[]; path: Buffer } {
  const values: string[] = []; let start = 0;
  for (let index = 0; index < count; index++) { const end = record.indexOf(32, start); if (end < 0) invalid(); values.push(record.subarray(start, end).toString('ascii')); start = end + 1; }
  return { values, path: record.subarray(start) };
}
export function parseStatus(bytes: Buffer): WorkingStatus {
  const records = nulRecords(bytes); const entries: StatusEntry[] = []; const untracked: GitPath[] = []; const headers: Record<string, string> = {};
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!; const tag = record.subarray(0, 2).toString('ascii');
    if (tag === '# ') { const value = text(record.subarray(2)); const space = value.indexOf(' '); if (space < 0) invalid(); headers[value.slice(0, space)] = value.slice(space + 1); }
    else if (tag === '? ') untracked.push(gitPath(record.subarray(2)));
    else if (tag === '1 ' || tag === '2 ' || tag === 'u ') {
      const parsed = fields(record, tag === '1 ' ? 8 : tag === '2 ' ? 9 : 10);
      const original = tag === '2 ' ? records[++index] : undefined;
      if (tag === '2 ' && !original) invalid();
      if (!/^[.MADRCUT?!]{2}$/u.test(parsed.values[1] ?? '')) invalid();
      entries.push({ ...gitPath(parsed.path), kind: tag === 'u ' ? 'conflict' : tag === '2 ' ? 'rename' : 'ordinary', xy: parsed.values[1]!, submodule: parsed.values[2]!, originalPath: original ? gitPath(original).path : null, originalPathBytes: original?.toString('base64') ?? null });
    } else invalid();
  }
  return { available: true, clean: entries.length === 0 && untracked.length === 0, entries, untracked, headers, reasons: [] };
}
export function parseRaw(bytes: Buffer): FileChange[] {
  const records = nulRecords(bytes); const changes: FileChange[] = [];
  for (let index = 0; index < records.length; index++) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([AMDRTU])([0-9]*)$/u.exec(records[index]!.toString('ascii'));
    if (!match) invalid();
    if (match[6] && Number(match[6]) > 100) invalid();
    const first = records[++index]; if (!first) invalid();
    const second = match[5] === 'R' ? records[++index] : first; if (!second) invalid();
    const old = gitPath(first); const dest = gitPath(second);
    changes.push({ originalPath: old.path, destinationPath: dest.path, originalPathBytes: old.pathBytes, destinationPathBytes: dest.pathBytes,
      status: match[5]!, similarity: match[6] ? Number(match[6]) : null, oldMode: match[1]!, newMode: match[2]!,
      oldOid: /^0+$/u.test(match[3]!) ? null : match[3]!, newOid: /^0+$/u.test(match[4]!) ? null : match[4]!,
      kind: match[1] === '160000' || match[2] === '160000' ? 'gitlink' : match[1] === '120000' || match[2] === '120000' ? 'symlink' : 'file', binary: false, added: null, deleted: null });
  }
  return changes;
}
export function joinNumstat(changes: FileChange[], bytes: Buffer, omittedPaths = new Set<string>()): void {
  const records = nulRecords(bytes); const counts = new Map<string, { added: number | null; deleted: number | null; binary: boolean }>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!; const first = record.indexOf(9); const second = record.indexOf(9, first + 1);
    if (first < 0 || second < 0) invalid();
    const a = record.subarray(0, first).toString('ascii'); const d = record.subarray(first + 1, second).toString('ascii');
    if (!/^(\d+|-)$/u.test(a) || !/^(\d+|-)$/u.test(d) || (a === '-') !== (d === '-')) invalid();
    if (a !== '-' && (!Number.isSafeInteger(Number(a)) || !Number.isSafeInteger(Number(d)))) invalid();
    let original = record.subarray(second + 1); let destination = original;
    if (!original.length) { original = records[++index]!; destination = records[++index]!; if (!original || !destination) invalid(); }
    const key = `${original.toString('base64')}:${destination.toString('base64')}`;
    if (omittedPaths.has(original.toString('base64')) || omittedPaths.has(destination.toString('base64'))) continue;
    if (counts.has(key)) invalid();
    counts.set(key, { added: a === '-' ? null : Number(a), deleted: d === '-' ? null : Number(d), binary: a === '-' });
  }
  for (const change of changes) {
    const key = `${change.originalPathBytes}:${change.destinationPathBytes}`; const count = counts.get(key);
    // Unmerged raw records have no ordinary two-sided numstat record.
    if (change.status === 'U') { counts.delete(key); continue; }
    if (!count) invalid();
    Object.assign(change, count);
    if (change.kind === 'gitlink') { change.added = null; change.deleted = null; }
    counts.delete(key);
  }
  if (counts.size) invalid();
}
