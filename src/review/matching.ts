import type { Evidence } from '../evidence/schema.js';
import type { ReadEvidenceBundle } from '../evidence/read.js';
import { ScanError } from '../config/load.js';
import { digest } from '../git/snapshot.js';
import { compareText } from '../git/identity.js';
import { acknowledgmentId, contextId, reviewLimits, validateReviewState, type Acknowledgment, type ReviewState, type ReviewRow } from './schema.js';

export type ReviewBundle = ReadEvidenceBundle;
type Hunk = Extract<Evidence, { kind: 'hunk' }>;
type File = Extract<Evidence, { kind: 'file-change' }>;
type Current = { hunk: Hunk; file: File; acknowledgment: Acknowledgment; eligible: boolean; identical: boolean; beforeUnique: boolean };
// Normalize patch presentation only: omit ranges/ordinals/headings, retain ordered
// kinds, exact bytes (including CR), and both sides' final-newline facts.
export function contentFingerprint(hunk: Hunk): string {
  return digest(['review-content-v1', hunk.data.lines.map(line => [line.kind, line.contentBytes, line.oldNoNewline, line.newNoNewline])]);
}
function beforeFingerprint(hunk: Hunk): string | null {
  const lines = hunk.data.lines.filter(line => line.kind !== 'add');
  return lines.length ? digest(['review-before-region-v1', lines.map(line => [line.contentBytes, line.oldNoNewline])]) : null;
}
function inventory(bundle: ReviewBundle): Current[] {
  const entries = new Map(bundle.evidence.map(entry => [entry.id, entry]));
  const current: Current[] = [];
  for (const hunk of bundle.evidence) {
    if (hunk.kind !== 'hunk') continue;
    const file = entries.get(hunk.data.fileEvidenceId), repo = bundle.repositories.find(repo => repo.repositoryId === hunk.repositoryId);
    const comparison = file?.kind === 'file-change' ? entries.get(file.data.comparisonEvidenceId) : undefined;
    if (file?.kind !== 'file-change' || comparison?.kind !== 'comparison' || !repo?.revisions || !repo.fingerprints || !hunk.comparisonId) throw new ScanError('REVIEW_EVIDENCE_INVALID', 'Hunk lacks validated repository/comparison parents', 2);
    const revisions = repo.revisions;
    const context: Acknowledgment['context'] = {
      repositoryId: repo.repositoryId, scope: comparison.data.scope,
      head: { state: revisions.head.state, branch: revisions.head.branch, detachedOid: revisions.head.state === 'detached' ? revisions.head.oid : null },
      base: { input: revisions.base.input, oid: revisions.base.oid },
      before: { kind: comparison.data.before.kind, commitOid: comparison.data.before.kind === 'commit' ? comparison.data.before.oid : null },
      comparisonOptions: bundle.request.comparisonOptions, configuration: repo.fingerprints.configuration, attributes: repo.fingerprints.attributes,
    };
    const payload: Omit<Acknowledgment, 'id'> = {
      contextId: contextId(context), context, snapshotId: hunk.snapshotId, comparisonId: hunk.comparisonId,
      hunkEvidenceId: hunk.id, fileEvidenceId: file.id, originalPathBytes: file.data.originalPathBytes, destinationPathBytes: file.data.destinationPathBytes,
      fileStatus: file.data.status, oldOid: file.data.oldOid, oldMode: file.data.oldMode,
      beforeRegion: file.data.oldOid ? { startLine: hunk.data.oldStart, lineCount: hunk.data.oldCount } : null,
      contentFingerprint: contentFingerprint(hunk), beforeFingerprint: beforeFingerprint(hunk), beforeUnique: false,
    };
    current.push({ hunk, file, acknowledgment: { ...payload, id: acknowledgmentId(payload) }, eligible: file.data.kind === 'file' && !file.data.binary && file.data.patch.state === 'complete' && file.data.patch.representation === 'unified', identical: false, beforeUnique: false });
  }
  if (current.length > reviewLimits.maxHunks) throw new ScanError('REVIEW_LIMIT', 'Too many hunks; narrow the exported evidence comparison', 1);
  const fullCounts = new Map<string, number>(), beforeCounts = new Map<string, number>();
  const key = (item: Current, fingerprint: string | null) => digest([item.file.id, fingerprint]);
  for (const item of current) {
    const full = key(item, item.acknowledgment.contentFingerprint); fullCounts.set(full, (fullCounts.get(full) ?? 0) + 1);
    const before = key(item, item.acknowledgment.beforeFingerprint); beforeCounts.set(before, (beforeCounts.get(before) ?? 0) + 1);
  }
  for (const item of current) {
    item.identical = fullCounts.get(key(item, item.acknowledgment.contentFingerprint))! > 1;
    item.beforeUnique = item.acknowledgment.beforeFingerprint !== null && beforeCounts.get(key(item, item.acknowledgment.beforeFingerprint)) === 1;
    item.acknowledgment.beforeUnique = item.beforeUnique;
    const { id: _id, ...payload } = item.acknowledgment; item.acknowledgment.id = acknowledgmentId(payload);
  }
  return current.sort((a, b) => compareText(a.acknowledgment.context.repositoryId, b.acknowledgment.context.repositoryId) || Buffer.compare(Buffer.from(a.file.data.destinationPathBytes, 'base64'), Buffer.from(b.file.data.destinationPathBytes, 'base64')) || a.hunk.data.ordinal - b.hunk.data.ordinal);
}
function sameFile(current: Acknowledgment, old: Acknowledgment): boolean {
  if (current.oldMode !== old.oldMode || current.oldOid !== old.oldOid) return false;
  // Coordinates are meaningful only within the SAME immutable Git blob, with
  // a matching content fingerprint/context. They are never standalone identity.
  // This prevents a single identical edit moving between repeated before regions.
  if (digest(current.beforeRegion) !== digest(old.beforeRegion)) return false;
  if (current.originalPathBytes === old.originalPathBytes && current.destinationPathBytes === old.destinationPathBytes) return true;
  // Only authoritative Git R metadata can move a reviewed path. A textual name
  // guess, delete/add pair or similarity of unrelated files never does so.
  return current.fileStatus === 'R' && current.oldOid !== null && current.originalPathBytes === old.originalPathBytes && (old.fileStatus === 'R' || old.destinationPathBytes === current.originalPathBytes);
}
function resolve(bundle: ReviewBundle, state: ReviewState) {
  const current = inventory(bundle), candidates = new Map<Current, Acknowledgment[]>(), reverse = new Map<string, Current[]>();
  const previous = new Map<string, Acknowledgment[]>();
  const lineageKey = (entry: Acknowledgment) => digest([entry.contextId, entry.oldMode, entry.oldOid, entry.originalPathBytes, entry.beforeRegion]);
  for (const entry of state.acknowledgments) { const key = lineageKey(entry), group = previous.get(key) ?? []; group.push(entry); previous.set(key, group); }
  for (const item of current) {
    const fresh = item.acknowledgment;
    const matches = !item.eligible || item.identical ? [] : (previous.get(lineageKey(fresh)) ?? []).filter(old => {
      if (old.contextId !== fresh.contextId || !sameFile(fresh, old)) return false;
      const exact = old.snapshotId === fresh.snapshotId && old.hunkEvidenceId === fresh.hunkEvidenceId;
      const uniqueRegion = item.beforeUnique && old.beforeUnique;
      return old.contentFingerprint === fresh.contentFingerprint && (exact || uniqueRegion || fresh.beforeFingerprint === null && old.beforeFingerprint === null)
        || fresh.oldOid !== null && uniqueRegion && old.beforeFingerprint === fresh.beforeFingerprint;
    });
    candidates.set(item, matches);
    for (const old of matches) { const group = reverse.get(old.id) ?? []; group.push(item); reverse.set(old.id, group); }
  }
  const rows: ReviewRow[] = current.map(item => {
    const fresh = item.acknowledgment, matches = candidates.get(item)!;
    const old = matches.length === 1 && reverse.get(matches[0]!.id)?.length === 1 ? matches[0]! : null;
    let reason: ReviewRow['reason'] = 'NO_ACKNOWLEDGMENT', status: ReviewRow['status'] = 'unseen';
    if (!item.eligible) reason = item.file.data.kind !== 'file' || item.file.data.binary ? 'UNSUPPORTED_FILE' : 'INCOMPLETE_FILE';
    else if (item.identical || matches.length && !old) reason = 'AMBIGUOUS_HUNKS';
    else if (old) { status = old.contentFingerprint === fresh.contentFingerprint ? 'reviewed' : 'changed-since-reviewed'; reason = status === 'reviewed' ? 'CONTENT_UNCHANGED' : 'BEFORE_REGION_CONTINUITY'; }
    return { repositoryId: fresh.context.repositoryId, contextId: fresh.contextId, scope: fresh.context.scope, snapshotId: fresh.snapshotId, comparisonId: fresh.comparisonId, hunkEvidenceId: fresh.hunkEvidenceId, fileEvidenceId: fresh.fileEvidenceId, path: item.file.data.destinationPath, pathBytes: fresh.destinationPathBytes, contentFingerprint: fresh.contentFingerprint, status, reason, acknowledgment: old ? { id: old.id, snapshotId: old.snapshotId, comparisonId: old.comparisonId, hunkEvidenceId: old.hunkEvidenceId } : null };
  });
  return { current, rows };
}
export function listReview(bundle: ReviewBundle, state: ReviewState): ReviewRow[] { return resolve(bundle, validateReviewState(state)).rows; }
export function markReview(bundle: ReviewBundle, state: ReviewState, snapshotId: string, hunkIds: string[]): ReviewState {
  if (!/^[a-f0-9]{64}$/u.test(snapshotId) || !hunkIds.length || new Set(hunkIds).size !== hunkIds.length || hunkIds.some(id => !/^[a-f0-9]{64}$/u.test(id))) throw new ScanError('ARGUMENT_INVALID', 'Provide one snapshot ID and distinct, explicit hunk evidence IDs', 2);
  const { current, rows } = resolve(bundle, validateReviewState(state));
  const selected = new Set(hunkIds), additions: Acknowledgment[] = [], replace = new Set<string>();
  for (const id of selected) {
    const item = current.find(item => item.hunk.id === id), row = rows.find(row => row.hunkEvidenceId === id);
    if (!item || !row || item.hunk.snapshotId !== snapshotId) throw new ScanError('REVIEW_TARGET_INVALID', 'Every selected hunk must exist in the supplied concrete snapshot', 2);
    if (!item.eligible || item.identical || row.reason === 'AMBIGUOUS_HUNKS') throw new ScanError('REVIEW_TARGET_AMBIGUOUS', 'Incomplete, unsupported or ambiguous hunks cannot be marked; no state was changed', 2);
    if (row.acknowledgment) replace.add(row.acknowledgment.id);
    additions.push(item.acknowledgment);
  }
  const acknowledgments = [...state.acknowledgments.filter(entry => !replace.has(entry.id)), ...additions].sort((a, b) => compareText(a.id, b.id));
  if (acknowledgments.length > reviewLimits.maxAcknowledgments) throw new ScanError('REVIEW_LIMIT', 'Review state acknowledgment limit reached; explicitly reset or narrow the workspace', 1);
  return validateReviewState({ ...state, acknowledgments });
}
