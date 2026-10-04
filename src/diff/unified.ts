import type { FileChange } from '../git/metadata.js';

export type PatchLine = { kind: 'context' | 'add' | 'remove'; content: string | null; contentBytes: string; oldLine: number | null; newLine: number | null; oldNoNewline: boolean; newNoNewline: boolean };
export type Hunk = { ordinal: number; hunkId?: string; oldStart: number; oldCount: number; newStart: number; newCount: number; heading: string | null; headingBytes: string; lines: PatchLine[]; noNewlineMarkers: { afterLine: number; side: 'old' | 'new' | 'both' }[] };
export type FilePatch = { state: 'complete' | 'partial' | 'metadata-only' | 'unavailable'; representation: 'unified' | 'binary' | 'gitlink' | 'unsupported'; hunks: Hunk[]; observedHunks: number; omittedHunks: number | null; reasons: string[] };
export type PatchDiagnostic = { code: string; fileKey: string | null; message: string };
export type PatchBounds = { maxHunks: number; maxFileBytes: number; maxOutputBytes: number; truncated?: boolean };
export const fileKey = (file: FileChange) => `${file.originalPathBytes}:${file.destinationPathBytes}`;

// Git's core.quotePath=true C quoting. Match whole headers against machine paths;
// splitting on spaces would misidentify unquoted filenames containing spaces.
export function quoteGitPath(bytes: Buffer): string {
  const escapes: Record<number, string> = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 34: '\\"', 92: '\\\\' };
  let value = ''; let quoted = false;
  for (const byte of bytes) {
    if (escapes[byte]) { value += escapes[byte]; quoted = true; }
    else if (byte < 32 || byte >= 127) { value += `\\${byte.toString(8).padStart(3, '0')}`; quoted = true; }
    else value += String.fromCharCode(byte);
  }
  return quoted ? `"${value}"` : value;
}
function header(file: FileChange): string {
  return `diff --git ${quoteGitPath(Buffer.concat([Buffer.from('a/'), Buffer.from(file.originalPathBytes, 'base64')]))} ${quoteGitPath(Buffer.concat([Buffer.from('b/'), Buffer.from(file.destinationPathBytes, 'base64')]))}`;
}
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function utf8(bytes: Buffer): string | null { try { return bytes.includes(0) ? null : decoder.decode(bytes); } catch { return null; } }

export function parseUnified(bytes: Buffer, files: FileChange[], bounds: PatchBounds) {
  const patches = new Map<string, FilePatch>(); const diagnostics: PatchDiagnostic[] = [];
  const headers = new Map<string, FileChange[]>();
  for (const file of files) { const name = header(file); headers.set(name, [...headers.get(name) ?? [], file]); }
  const issued = new Set<string>();
  const seen = new Set<string>(); let retainedBytes = 0; let totalHunks = 0;
  for (const file of files) patches.set(fileKey(file), { state: file.binary || file.kind === 'gitlink' ? 'metadata-only' : 'complete', representation: file.binary ? 'binary' : file.kind === 'gitlink' ? 'gitlink' : 'unified', hunks: [], observedHunks: 0, omittedHunks: 0, reasons: [] });
  function issue(code: string, key: string | null, message: string) {
    const patch = key === null ? undefined : patches.get(key);
    if (patch) { patch.state = 'partial'; if (!patch.reasons.includes(code)) patch.reasons.push(code); }
    const identity = `${code}:${key}`;
    if (!issued.has(identity)) { issued.add(identity); diagnostics.push({ code, fileKey: key, message }); }
  }
  let cursor = 0;
  function next() { const start = cursor; const end = bytes.indexOf(10, start); cursor = end < 0 ? bytes.length : end + 1; return { bytes: bytes.subarray(start, end < 0 ? bytes.length : end), terminated: end >= 0, start }; }
  let current: { file: FileChange; key: string; start: number; patch: FilePatch; lastOldEnd: number; lastNewEnd: number } | null = null;
  let pending: ReturnType<typeof next> | null = null;
  let lastHunk: { patch: FilePatch; hunk: Hunk } | null = null;
  while (pending || cursor < bytes.length) {
    const record = pending ?? next(); pending = null;
    const line = record.bytes.toString('latin1');
    if (line.startsWith('diff --git ')) {
      lastHunk = null;
      const candidates = headers.get(line); current = null;
      if (!candidates?.length) { issue('PATCH_PATH_UNMAPPED', null, 'Patch header does not match authoritative Git paths'); continue; }
      let file = candidates[0]!;
      if (candidates.length !== 1) {
        // Rename pairs can share an unquoted first header. Git's separate
        // rename headers disambiguate against the same authoritative paths.
        let probe = cursor; let from: string | null = null; let to: string | null = null;
        while (probe < bytes.length) {
          const end = bytes.indexOf(10, probe); const value = bytes.subarray(probe, end < 0 ? bytes.length : end).toString('latin1');
          if (value.startsWith('@@') || value.startsWith('diff --')) break;
          if (value.startsWith('rename from ')) from = value.slice(12);
          if (value.startsWith('rename to ')) to = value.slice(10);
          probe = end < 0 ? bytes.length : end + 1;
        }
        const matching = candidates.filter(candidate => quoteGitPath(Buffer.from(candidate.originalPathBytes, 'base64')) === from && quoteGitPath(Buffer.from(candidate.destinationPathBytes, 'base64')) === to);
        if (matching.length !== 1) { issue('PATCH_PATH_AMBIGUOUS', null, 'Patch header has multiple authoritative path pairs and cannot be disambiguated; no hunk identity is guessed'); continue; }
        file = matching[0]!;
      }
      const key = fileKey(file); const patch = patches.get(key)!;
      if (seen.has(key) && file.status !== 'T') issue('PATCH_SECTION_DUPLICATE', key, 'Repeated file section without an authoritative type change');
      seen.add(key);
      // Type changes may have separate delete/add sections for the same path.
      current = { file, key, start: record.start, patch, lastOldEnd: -1, lastNewEnd: -1 };
      continue;
    }
    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ') || line.startsWith('@@@')) {
      issue('UNSUPPORTED_COMBINED_PATCH', current?.key ?? null, 'Combined/conflict patch cannot be represented as a two-sided unified hunk'); current = null; continue;
    }
    if (line.startsWith('* Unmerged path ')) { issue('UNMERGED_PATCH', null, 'Git reports an unmerged path; ordinary hunks are unavailable'); current = null; continue; }
    if (!current) { if (line.startsWith('@@ ')) { totalHunks++; issue('ORPHAN_HUNK', null, 'Hunk has no matched file header'); } continue; }
    const { file, key, patch } = current;
    if (line === 'GIT binary patch') { issue('BINARY_PAYLOAD_NOT_EXPORTED', key, 'Git binary payload is outside the text evidence contract'); patch.representation = 'binary'; current = null; continue; }
    if (line.startsWith('Binary files ')) { if (!file.binary) issue('PATCH_BINARY_MISMATCH', key, 'Patch and Git numstat disagree about binary representation'); patch.representation = 'binary'; continue; }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const old = line.startsWith('--- '); const expected = quoteGitPath(Buffer.concat([Buffer.from(old ? 'a/' : 'b/'), Buffer.from(old ? file.originalPathBytes : file.destinationPathBytes, 'base64')]));
      const value = line.slice(4).replace(/\t$/u, '');
      if (value !== expected && !(value === '/dev/null' && (old && file.status === 'A' || !old && file.status === 'D' || file.status === 'T'))) issue('PATCH_PATH_MISMATCH', key, 'Unified path header disagrees with Git machine metadata');
      continue;
    }
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      const old = line.startsWith('rename from '); const expected = quoteGitPath(Buffer.from(old ? file.originalPathBytes : file.destinationPathBytes, 'base64'));
      if (file.status !== 'R' || line.slice(old ? 12 : 10) !== expected) issue('PATCH_PATH_MISMATCH', key, 'Rename header disagrees with authoritative Git paths');
      continue;
    }
    if (!line.startsWith('@@')) {
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('\\')) issue('ORPHAN_PATCH_LINE', key, 'Unexpected patch body outside a declared hunk');
      else if (line && !/^(?:index |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |Submodule )/u.test(line)) issue('UNSUPPORTED_PATCH_HEADER', key, 'Unsupported extended patch representation');
      continue;
    }
    lastHunk = null;
    totalHunks++; patch.observedHunks++;
    const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u.exec(line);
    let invalid = !range;
    const oldStart = Number(range?.[1] ?? 0), oldCount = Number(range?.[2] ?? 1), newStart = Number(range?.[3] ?? 0), newCount = Number(range?.[4] ?? 1);
    if (![oldStart, oldCount, newStart, newCount, oldStart + oldCount, newStart + newCount].every(Number.isSafeInteger) || oldStart === 0 && oldCount !== 0 || newStart === 0 && newCount !== 0 || oldCount > 0 && oldStart < current.lastOldEnd || newCount > 0 && newStart < current.lastNewEnd) invalid = true;
    const headingBytes = record.bytes.subarray(record.bytes.indexOf(Buffer.from(' @@')) + 3); const heading = utf8(headingBytes);
    const hunk: Hunk = { ordinal: patch.observedHunks, oldStart, oldCount, newStart, newCount, heading, headingBytes: headingBytes.toString('base64'), lines: [], noNewlineMarkers: [] };
    let oldSeen = 0, newSeen = 0, lineNumber = 0, hunkBytes = Buffer.byteLength(JSON.stringify(hunk)); let previous: PatchLine | null = null;
    let omission: string | null = totalHunks > bounds.maxHunks ? 'HUNK_LIMIT' : null;
    if (record.start + record.bytes.length - current.start > bounds.maxFileBytes) omission = 'PATCH_FILE_LIMIT';
    if (retainedBytes + hunkBytes + 1024 > bounds.maxOutputBytes) omission = 'PATCH_OUTPUT_LIMIT';
    if (file.binary || file.kind === 'gitlink') omission = 'METADATA_ONLY';
    while (cursor < bytes.length) {
      const body = next(); const prefix = body.bytes[0];
      if (body.bytes.equals(Buffer.from('\\ No newline at end of file'))) {
        if (!previous || previous.oldNoNewline || previous.newNoNewline || !body.terminated) invalid = true;
        else {
          const side = previous.kind === 'remove' ? 'old' : previous.kind === 'add' ? 'new' : 'both';
          previous.oldNoNewline = side !== 'new'; previous.newNoNewline = side !== 'old';
          if (!omission) hunk.noNewlineMarkers.push({ afterLine: lineNumber, side });
        }
        continue;
      }
      if ((prefix !== 32 && prefix !== 43 && prefix !== 45) || oldSeen === oldCount && newSeen === newCount) { pending = body; break; }
      const kind = prefix === 32 ? 'context' : prefix === 43 ? 'add' : 'remove'; const content = body.bytes.subarray(1); const contentText = utf8(content);
      if (content.includes(0) || !body.terminated) invalid = true;
      const item: PatchLine = { kind, content: contentText, contentBytes: content.toString('base64'), oldLine: kind === 'add' ? null : oldStart + oldSeen, newLine: kind === 'remove' ? null : newStart + newSeen, oldNoNewline: false, newNoNewline: false };
      if (kind !== 'add') oldSeen++; if (kind !== 'remove') newSeen++; lineNumber++; previous = item;
      hunkBytes += Buffer.byteLength(JSON.stringify(item)) + 64;
      if (body.start + body.bytes.length + (body.terminated ? 1 : 0) - current.start > bounds.maxFileBytes) omission = 'PATCH_FILE_LIMIT';
      if (retainedBytes + hunkBytes + 1024 > bounds.maxOutputBytes) omission = 'PATCH_OUTPUT_LIMIT';
      if (!omission) hunk.lines.push(item); else hunk.lines.length = 0;
    }
    if (oldSeen !== oldCount || newSeen !== newCount) invalid = true;
    current.lastOldEnd = oldStart + oldCount; current.lastNewEnd = newStart + newCount;
    if (invalid || omission) {
      patch.omittedHunks = (patch.omittedHunks ?? 0) + 1;
      if (omission !== 'METADATA_ONLY' || invalid) issue(invalid ? 'HUNK_INVALID' : omission!, key, invalid ? 'Hunk is incomplete, unsupported text, unordered, or disagrees with its declared ranges' : `Whole hunk omitted: ${omission}`);
    } else { patch.hunks.push(hunk); retainedBytes += hunkBytes + 1024; lastHunk = { patch, hunk }; }
  }
  if (bounds.truncated) {
    issue('PATCH_TRUNCATED', null, 'Git output exceeded maxPatchBytes; total bytes and omitted hunk count are unknown');
    // A prefix can end between a completed hunk and its no-newline marker.
    if (lastHunk && current?.patch === lastHunk.patch && lastHunk.patch.hunks.at(-1) === lastHunk.hunk) { lastHunk.patch.hunks.pop(); }
    for (const [key, patch] of patches) { patch.omittedHunks = null; issue('PATCH_TRUNCATED', key, 'Patch completeness cannot be verified after output truncation'); }
  }
  for (const file of files) {
    const key = fileKey(file); const patch = patches.get(key)!;
    if (!seen.has(key)) { issue('PATCH_SECTION_MISSING', key, 'Git metadata has a changed file without a collected patch section'); patch.state = 'unavailable'; patch.omittedHunks = null; }
    if (patch.state === 'complete') {
      const added = patch.hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.kind === 'add').length, 0);
      const deleted = patch.hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.kind === 'remove').length, 0);
      if (added !== file.added || deleted !== file.deleted) { issue('PATCH_COUNT_MISMATCH', key, 'Parsed addition/deletion counts disagree with Git numstat'); patch.omittedHunks = null; }
    }
    // Untrusted headers never cause retained hunks to acquire another identity.
    if (patch.reasons.includes('PATCH_PATH_MISMATCH')) { patch.omittedHunks = patch.observedHunks; patch.hunks = []; }
  }
  return { patches, diagnostics, observedHunks: totalHunks, retainedOutputBytes: retainedBytes };
}
