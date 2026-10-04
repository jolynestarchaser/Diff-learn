import { z } from 'zod';
import { ScanError } from '../config/load.js';
import { digest } from '../git/snapshot.js';
import { errorSchema, scopeSchema } from '../evidence/schema.js';

export const reviewLimits = { maxEvidenceBytes: 64 * 1024 * 1024, maxStateBytes: 16 * 1024 * 1024, maxAcknowledgments: 20_000, maxHunks: 20_000 } as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const bytes = z.string().min(1).refine(value => Buffer.from(value, 'base64').toString('base64') === value, 'Noncanonical base64');
export const reviewContextSchema = z.strictObject({
  repositoryId: hash, scope: scopeSchema,
  head: z.strictObject({ state: z.enum(['attached', 'detached', 'unborn']), branch: z.string().nullable(), detachedOid: oid.nullable() }),
  base: z.strictObject({ input: z.string().nullable(), oid: oid.nullable() }),
  before: z.strictObject({ kind: z.enum(['commit', 'index', 'working-tree', 'empty-tree']), commitOid: oid.nullable() }),
  comparisonOptions: z.array(z.string()), configuration: hash, attributes: hash,
});
export const acknowledgmentSchema = z.strictObject({
  id: hash, contextId: hash, context: reviewContextSchema,
  snapshotId: hash, comparisonId: hash, hunkEvidenceId: hash, fileEvidenceId: hash,
  originalPathBytes: bytes, destinationPathBytes: bytes, fileStatus: z.enum(['A', 'M', 'D', 'R', 'T']),
  oldOid: oid.nullable(), oldMode: z.string().regex(/^[0-7]{6}$/u),
  beforeRegion: z.strictObject({ startLine: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), lineCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).nullable(),
  contentFingerprint: hash, beforeFingerprint: hash.nullable(), beforeUnique: z.boolean(),
});
export type Acknowledgment = z.infer<typeof acknowledgmentSchema>;
export const reviewStateSchema = z.strictObject({
  schemaVersion: z.literal('1.0.0'), stateKind: z.literal('hunk-review'), matchingPolicy: z.literal('conservative-byte-content-v1'),
  acknowledgments: z.array(acknowledgmentSchema).max(reviewLimits.maxAcknowledgments),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;
export const emptyReviewState = (): ReviewState => ({ schemaVersion: '1.0.0', stateKind: 'hunk-review', matchingPolicy: 'conservative-byte-content-v1', acknowledgments: [] });
export const contextId = (context: Acknowledgment['context']) => digest(['review-context-v1', context]);
export function acknowledgmentId(entry: Omit<Acknowledgment, 'id'>): string { return digest(['review-acknowledgment-v1', entry]); }
export function validateReviewState(value: unknown): ReviewState {
  if (value !== null && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== '1.0.0') throw new ScanError('REVIEW_STATE_VERSION', 'Review state version is unsupported; use explicit review reset to discard it', 1);
  const result = reviewStateSchema.safeParse(value);
  if (!result.success) throw new ScanError('REVIEW_STATE_CORRUPT', 'Invalid review state; preserve it for inspection or use explicit review reset', 1);
  const ids = new Set<string>();
  for (const entry of result.data.acknowledgments) {
    const { id, ...payload } = entry;
    if (ids.has(id) || id !== acknowledgmentId(payload) || entry.contextId !== contextId(entry.context) || entry.beforeUnique && entry.beforeFingerprint === null || (entry.oldOid === null) !== (entry.beforeRegion === null)) throw new ScanError('REVIEW_STATE_CORRUPT', 'Invalid or duplicate review acknowledgment identity', 1);
    ids.add(id);
  }
  return result.data;
}
export const reviewRowSchema = z.strictObject({
  repositoryId: hash, contextId: hash, scope: scopeSchema, snapshotId: hash, comparisonId: hash,
  hunkEvidenceId: hash, fileEvidenceId: hash, path: z.string().nullable(), pathBytes: bytes,
  contentFingerprint: hash,
  status: z.enum(['unseen', 'reviewed', 'changed-since-reviewed']),
  reason: z.enum(['NO_ACKNOWLEDGMENT', 'CONTENT_UNCHANGED', 'BEFORE_REGION_CONTINUITY', 'AMBIGUOUS_HUNKS', 'INCOMPLETE_FILE', 'UNSUPPORTED_FILE']),
  acknowledgment: z.strictObject({ id: hash, snapshotId: hash, comparisonId: hash, hunkEvidenceId: hash }).nullable(),
});
export type ReviewRow = z.infer<typeof reviewRowSchema>;
export const reviewReportSchema = z.strictObject({
  schemaVersion: z.literal('1.0.0'), reportKind: z.literal('review'), operation: z.enum(['mark', 'list', 'reset']),
  stateFile: z.string(), statePresence: z.enum(['absent', 'loaded', 'written']), matchingPolicy: z.literal('conservative-byte-content-v1'),
  evidenceDigest: hash.nullable(), inputCompleteness: z.enum(['complete', 'partial', 'failed']).nullable(),
  rows: z.array(reviewRowSchema).max(reviewLimits.maxHunks), markedHunkEvidenceIds: z.array(hash), removedAcknowledgments: z.number().int().nonnegative().nullable(),
  completeness: z.strictObject({ state: z.enum(['complete', 'partial']), reasons: z.array(z.string()) }),
  diagnostics: z.array(z.strictObject({ code: z.string(), severity: z.literal('warning'), message: z.string() })),
  interpretation: z.literal('explicit-human-acknowledgment-not-correctness'),
});
export const reviewOutputSchema = z.union([reviewReportSchema, errorSchema]);
export type ReviewReport = z.infer<typeof reviewReportSchema>;
