import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ScanError } from '../config/load.js';
import { digest } from '../git/snapshot.js';

const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = uint.min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const mode = z.string().regex(/^[0-7]{6}$/u);
const bytes = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u).refine(value => Buffer.from(value, 'base64').toString('base64') === value, 'Noncanonical base64');
const code = z.string().regex(/^[A-Z][A-Z0-9_]*$/u);
const timestamp = z.iso.datetime();
const state = z.enum(['complete', 'partial', 'failed']);
export const scopeSchema = z.enum(['branch', 'staged', 'unstaged', 'all']);
const pathShape = { path: z.string().nullable(), pathBytes: bytes.min(1) };
const gitPath = z.strictObject(pathShape);
const endpoint = z.strictObject({ kind: z.enum(['commit', 'index', 'working-tree', 'empty-tree']), oid: oid.nullable() });
const base = z.strictObject({ input: z.string().nullable(), resolutionSource: z.string().nullable(), oid: oid.nullable(), reason: code.nullable(), remoteFreshness: z.literal('not-verified') });
const revisions = z.strictObject({ head: z.strictObject({ oid: oid.nullable(), branch: z.string().nullable(), state: z.enum(['attached', 'detached', 'unborn']) }), base, mergeBase: z.strictObject({ oid: oid.nullable(), candidates: z.array(oid), reason: code.nullable(), shallow: z.boolean() }) });
const status = z.strictObject({ available: z.boolean(), clean: z.boolean().nullable(), reasons: z.array(code), headers: z.record(z.string(), z.string()), untracked: z.array(gitPath), entries: z.array(z.strictObject({ ...pathShape, kind: z.enum(['ordinary', 'rename', 'conflict']), xy: z.string().regex(/^[.MADRCUT?!]{2}$/u), submodule: z.string(), originalPath: z.string().nullable(), originalPathBytes: bytes.nullable() })) });
const fingerprints = z.strictObject({ index: hash, workingTree: hash, configuration: hash, attributes: hash });
const capabilities = z.strictObject({ sparseCheckout: z.boolean(), restrictedPaths: z.array(z.strictObject({ path: z.string().nullable(), reason: code })), activeFilterPaths: z.array(z.string()), intentToAddPaths: z.array(gitPath), intentToAddPolicy: z.literal('experimental-visible-in-index') });
const submodules = z.array(z.strictObject({ path: z.string(), childContent: z.literal('not-collected') }));
const snapshot = z.strictObject({ snapshotId: hash.nullable(), consistency: z.enum(['verified-optimistic', 'inconsistent', 'unverified']), attempts: uint.max(2), startedAt: timestamp, endedAt: timestamp, bytesHashed: uint });
const coverage = z.strictObject({ source: z.literal('git'), retainedBytes: uint, observedBytesLowerBound: uint, totalBytes: uint.nullable(), truncated: z.boolean(), observedHunks: uint, omittedHunks: uint.nullable() });
const patch = z.strictObject({ state: z.enum(['complete', 'partial', 'metadata-only', 'unavailable']), representation: z.enum(['unified', 'binary', 'gitlink', 'unsupported']), observedHunks: uint, collectedHunks: uint, omittedHunks: uint.nullable(), reasons: z.array(code) });
const comparisonData = z.strictObject({ scope: scopeSchema, state: z.enum(['complete', 'partial', 'unavailable']), before: endpoint, after: endpoint, base, reasons: z.array(code), omittedCount: uint.nullable(), fileCount: uint, patchCoverage: coverage.nullable() });
const fileData = z.strictObject({ comparisonEvidenceId: hash, originalPath: z.string().nullable(), destinationPath: z.string().nullable(), originalPathBytes: bytes.min(1), destinationPathBytes: bytes.min(1), status: z.enum(['A', 'M', 'D', 'R', 'T']), similarity: uint.max(100).nullable(), oldMode: mode, newMode: mode, oldOid: oid.nullable(), newOid: oid.nullable(), kind: z.enum(['file', 'symlink', 'gitlink']), binary: z.boolean(), added: uint.nullable(), deleted: uint.nullable(), patch: patch });
const line = z.strictObject({ kind: z.enum(['context', 'add', 'remove']), content: z.string().nullable(), contentBytes: bytes, oldLine: positive.nullable(), newLine: positive.nullable(), oldNoNewline: z.boolean(), newNoNewline: z.boolean() });
const hunkData = z.strictObject({ fileEvidenceId: hash, ordinal: positive, oldStart: uint, oldCount: uint, newStart: uint, newCount: uint, heading: z.string().nullable(), headingBytes: bytes, lines: z.array(line), noNewlineMarkers: z.array(z.strictObject({ afterLine: positive, side: z.enum(['old', 'new', 'both']) })) });
const content = z.strictObject({ source: z.literal('filesystem'), contentId: hash.nullable(), state: z.enum(['collected', 'omitted']), reason: code.nullable(), sha256: hash.nullable(), byteLength: uint.nullable(), text: z.string().nullable(), bytes: bytes.nullable() });
const untrackedData = z.strictObject({ ...pathShape, type: z.string(), size: uint.nullable(), contentPolicy: z.enum(['metadata-only', 'opt-in-text']), content: content.nullable() });
const conflictStage = z.strictObject({ mode, oid }).nullable();
const conflictData = z.strictObject({ ...pathShape, xy: z.string().nullable(), stages: z.strictObject({ base: conflictStage, ours: conflictStage, theirs: conflictStage }) });
const repositoryData = z.strictObject({ key: z.string(), path: z.string(), objectFormat: z.enum(['sha1', 'sha256']), linkedWorktree: z.boolean(), submodules, revisions, workingTree: status, fingerprints, capabilities });
export const sourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('git'), method: z.enum(['snapshot-metadata', 'comparison-plan', 'diff-raw-numstat', 'conflict-index']), executed: z.boolean(), arguments: z.array(z.array(z.string())), inputOids: z.array(oid), originatingEvidenceIds: z.array(hash) }),
  z.strictObject({ kind: z.literal('filesystem'), method: z.enum(['lstat', 'bounded-read-and-hash', 'not-read']), pathBytes: bytes.min(1), sha256: hash.nullable(), interval: z.strictObject({ startedAt: timestamp, endedAt: timestamp }), originatingEvidenceIds: z.array(hash) }),
  z.strictObject({ kind: z.literal('diff-parser'), method: z.literal('unified-two-sided'), arguments: z.array(z.string()), inputOids: z.array(oid), originatingEvidenceIds: z.array(hash) }),
]);
const subject = z.strictObject({ pathBytes: bytes.nullable(), originalPathBytes: bytes.nullable(), ordinal: positive.nullable() });
const common = { id: hash, repositoryId: hash, snapshotId: hash, comparisonId: hash.nullable(), subject, source: sourceSchema, confidence: z.literal('fact') };
export const evidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('repository'), data: repositoryData }),
  z.strictObject({ ...common, kind: z.literal('comparison'), data: comparisonData }),
  z.strictObject({ ...common, kind: z.literal('file-change'), data: fileData }),
  z.strictObject({ ...common, kind: z.literal('hunk'), data: hunkData }),
  z.strictObject({ ...common, kind: z.literal('untracked-file'), data: untrackedData }),
  z.strictObject({ ...common, kind: z.literal('conflict'), data: conflictData }),
]);
export type Evidence = z.infer<typeof evidenceSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Subject = z.infer<typeof subject>;
export function evidenceId(entry: Pick<Evidence, 'repositoryId' | 'snapshotId' | 'comparisonId' | 'kind' | 'subject' | 'data'>): string {
  return digest(['evidence-v1', entry.repositoryId, entry.comparisonId ?? entry.snapshotId, entry.kind, entry.subject, entry.data]);
}
export const diagnosticSchema = z.strictObject({ code, severity: z.enum(['warning', 'error']), stage: z.enum(['discovery', 'collection', 'export']), repositoryId: hash.nullable(), path: z.string().nullable(), scope: scopeSchema.nullable(), message: z.string() });
export const limitsSchema = z.strictObject({ maxDepth: uint.max(1024), maxDirectories: positive, maxRepositories: positive, concurrency: positive.max(32), gitTimeoutMs: positive, repoTimeoutMs: positive, maxMetadataBytes: positive, maxFiles: positive, maxHunks: positive, maxFileBytes: positive, maxPatchBytes: positive, maxBundleBytes: positive.min(65_536), maxSnapshotBytes: positive, maxWorkspaceSnapshotBytes: positive });
const inventory = { repositoryId: hash, key: z.string(), path: z.string(), kind: z.enum(['worktree', 'unsupported-bare', 'failed']), topLevel: z.string().nullable(), gitDirectory: z.string().nullable(), commonDirectory: z.string().nullable(), linkedWorktree: z.boolean().nullable(), objectFormat: z.enum(['sha1', 'sha256']).nullable(), baseConfiguration: z.strictObject({ input: z.string().nullable(), source: z.enum(['repository-config', 'workspace-config']).nullable(), state: z.literal('not-resolved') }), submodules };
const repositoryOutcome = z.strictObject({ ...inventory, state, reasons: z.array(code), snapshot, revisions: revisions.nullable(), workingTree: status.nullable(), fingerprints: fingerprints.nullable(), capabilities: capabilities.nullable(), repositoryEvidenceId: hash.nullable(), untrackedEvidenceIds: z.array(hash), conflictEvidenceIds: z.array(hash), excludedUntrackedCount: uint.nullable(), comparisons: z.array(z.strictObject({ ...comparisonData.shape, comparisonId: hash.nullable(), evidenceId: hash, fileEvidenceIds: z.array(hash) })) });
const discovery = z.strictObject({ visitedDirectories: uint, readableDirectories: uint, candidateCount: uint, discoveredCount: uint, selectedCount: uint, remainingCount: uint.nullable(), subprocessConcurrency: z.literal(1), excludeDirectories: z.array(z.string()), excludePaths: z.array(z.string()), submodulePolicy: z.literal('parent-only'), symlinkPolicy: z.literal('do-not-follow'), skippedCount: uint, omittedDetails: uint, skipped: z.array(z.strictObject({ path: z.string(), reason: z.string() })), incompleteSubtrees: z.array(z.string()) });
export const unsupportedAnalysis = ['changed-symbols', 'references', 'behavior', 'return-types', 'impact', 'test-coverage', 'history', 'review-state'] as const;
export const bundleSchema = z.strictObject({
  schemaVersion: z.literal('1.0.0'), reportKind: z.literal('evidence'), collector: z.strictObject({ name: z.literal('difflearn'), version: z.string(), gitVersion: z.string() }), collection: z.strictObject({ startedAt: timestamp, endedAt: timestamp }),
  request: z.strictObject({ root: z.string(), configPath: z.string().nullable(), repositories: z.array(z.string()), base: z.string().nullable(), scopes: z.array(scopeSchema).length(1), contentPolicy: z.enum(['metadata-only', 'opt-in-text']), comparisonOptions: z.array(z.string()), immutableAttributeSource: z.literal('captured-head'), limits: limitsSchema }),
  discovery, repositories: z.array(repositoryOutcome), evidence: z.array(evidenceSchema), diagnostics: z.array(diagnosticSchema),
  completeness: z.strictObject({ state, reasons: z.array(code), repositoryStates: z.array(z.strictObject({ repositoryId: hash, state })), requestedRepositories: uint, collectedRepositories: uint, collectedEvidence: uint, omittedCount: uint.nullable() }),
  analysis: z.strictObject({ policy: z.literal('git-facts-only'), unsupported: z.array(z.enum(unsupportedAnalysis)) }),
  trust: z.strictObject({ repositoryContent: z.literal('untrusted-agent-input'), export: z.literal('explicit-command-stdout-only') }),
});
export type EvidenceBundle = z.infer<typeof bundleSchema>;
export const errorSchema = z.strictObject({ schemaVersion: z.literal('1.0.0'), reportKind: z.literal('error'), completeness: z.strictObject({ state: z.literal('failed') }), diagnostics: z.array(z.strictObject({ code, severity: z.literal('error'), message: z.string() })) });
export const outputSchema = z.discriminatedUnion('reportKind', [bundleSchema, errorSchema]);
const contractError = () => new ScanError('INTERNAL_CONTRACT_ERROR', 'Generated evidence violated the runtime contract; no unchecked bundle was emitted', 1);
export function validateEntry(value: unknown): Evidence { const parsed = evidenceSchema.safeParse(value); if (!parsed.success) throw contractError(); return parsed.data; }
function lossless(text: string | null, encoded: string): boolean { return text === null || Buffer.from(text).equals(Buffer.from(encoded, 'base64')); }

export function validateBundle(value: unknown): EvidenceBundle {
  const parsed = bundleSchema.safeParse(value); if (!parsed.success) throw contractError();
  const bundle = parsed.data; const entries = new Map<string, Evidence>(); const repositories = new Map(bundle.repositories.map(repo => [repo.repositoryId, repo]));
  const hunksByFile = new Map<string, Extract<Evidence, { kind: 'hunk' }>[]>();
  const fail = (condition: unknown) => { if (!condition) throw contractError(); };
  fail(repositories.size === bundle.repositories.length);
  fail(bundle.analysis.unsupported.length === unsupportedAnalysis.length && unsupportedAnalysis.every(kind => bundle.analysis.unsupported.includes(kind)));
  fail(bundle.collection.startedAt <= bundle.collection.endedAt);
  for (const entry of bundle.evidence) { fail(!entries.has(entry.id)); fail(entry.id === evidenceId(entry)); entries.set(entry.id, entry); if (entry.kind === 'hunk') { const hunks = hunksByFile.get(entry.data.fileEvidenceId) ?? []; hunks.push(entry); hunksByFile.set(entry.data.fileEvidenceId, hunks); } }
  for (const entry of bundle.evidence) {
    const repo = repositories.get(entry.repositoryId); fail(repo && repo.snapshot.consistency === 'verified-optimistic' && repo.snapshot.snapshotId === entry.snapshotId);
    for (const id of entry.source.originatingEvidenceIds) { const origin = entries.get(id); fail(origin && origin.id !== entry.id && origin.repositoryId === entry.repositoryId && origin.snapshotId === entry.snapshotId); }
    if (entry.kind === 'repository') {
      fail(entry.source.kind === 'git' && entry.comparisonId === null && repo?.repositoryEvidenceId === entry.id);
      fail(repo && digest(entry.data) === digest({ key: repo.key, path: repo.path, objectFormat: repo.objectFormat, linkedWorktree: repo.linkedWorktree, submodules: repo.submodules, revisions: repo.revisions, workingTree: repo.workingTree, fingerprints: repo.fingerprints, capabilities: repo.capabilities }));
    }
    if (entry.kind === 'comparison') {
      fail(entry.source.kind === 'git'); const outcome = repo?.comparisons.find(item => item.evidenceId === entry.id); fail(outcome && outcome.comparisonId === entry.comparisonId && outcome.scope === entry.data.scope);
      if (outcome) { const { comparisonId: _id, evidenceId: _evidenceId, fileEvidenceIds: _files, ...data } = outcome; fail(digest(data) === digest(entry.data)); }
      if (entry.data.state !== 'unavailable') fail(entry.comparisonId !== null && (entry.data.before.kind !== 'commit' || entry.data.before.oid !== null) && (entry.data.after.kind !== 'commit' || entry.data.after.oid !== null));
    }
    if (entry.kind === 'file-change') {
      const parent = entries.get(entry.data.comparisonEvidenceId); fail(parent?.kind === 'comparison' && parent.repositoryId === entry.repositoryId && parent.comparisonId === entry.comparisonId && parent.data.state !== 'unavailable');
      fail(entry.source.kind === 'git' && entry.comparisonId !== null);
      fail(lossless(entry.data.originalPath, entry.data.originalPathBytes) && lossless(entry.data.destinationPath, entry.data.destinationPathBytes));
      fail(entry.subject.pathBytes === entry.data.destinationPathBytes && entry.subject.originalPathBytes === entry.data.originalPathBytes);
      if (entry.data.binary || entry.data.kind === 'gitlink') fail(entry.data.added === null && entry.data.deleted === null);
      else fail(entry.data.added !== null && entry.data.deleted !== null);
      const hunks = hunksByFile.get(entry.id) ?? [];
      fail(hunks.length === entry.data.patch.collectedHunks && hunks.length <= entry.data.patch.observedHunks);
      fail(hunks.every((hunk, index) => index === 0 || hunk.data.ordinal > hunks[index - 1]!.data.ordinal));
      if (entry.data.patch.state === 'complete') {
        fail(entry.data.patch.omittedHunks === 0 && hunks.length === entry.data.patch.observedHunks);
        fail(hunks.reduce((sum, item) => sum + item.data.lines.filter(line => line.kind === 'add').length, 0) === entry.data.added);
        fail(hunks.reduce((sum, item) => sum + item.data.lines.filter(line => line.kind === 'remove').length, 0) === entry.data.deleted);
      }
    }
    if (entry.kind === 'hunk') {
      const parent = entries.get(entry.data.fileEvidenceId); fail(parent?.kind === 'file-change' && parent.repositoryId === entry.repositoryId && parent.comparisonId === entry.comparisonId && !parent.data.binary && parent.data.kind !== 'gitlink');
      fail(entry.source.kind === 'diff-parser' && entry.source.originatingEvidenceIds.includes(entry.data.fileEvidenceId));
      fail(entry.subject.ordinal === entry.data.ordinal && lossless(entry.data.heading, entry.data.headingBytes));
      if (parent?.kind === 'file-change') fail(entry.subject.pathBytes === parent.subject.pathBytes && entry.subject.originalPathBytes === parent.subject.originalPathBytes);
      let old = entry.data.oldStart, fresh = entry.data.newStart;
      fail((old !== 0 || entry.data.oldCount === 0) && (fresh !== 0 || entry.data.newCount === 0));
      for (const line of entry.data.lines) {
        fail(lossless(line.content, line.contentBytes) && !Buffer.from(line.contentBytes, 'base64').includes(0));
        fail(line.oldLine === (line.kind === 'add' ? null : old) && line.newLine === (line.kind === 'remove' ? null : fresh));
        if (line.kind !== 'add') old++; if (line.kind !== 'remove') fresh++;
      }
      fail(old === entry.data.oldStart + entry.data.oldCount && fresh === entry.data.newStart + entry.data.newCount && Number.isSafeInteger(old) && Number.isSafeInteger(fresh));
      const markers = new Map<number, 'old' | 'new' | 'both'>();
      for (const marker of entry.data.noNewlineMarkers) { fail(!markers.has(marker.afterLine) && marker.afterLine <= entry.data.lines.length); markers.set(marker.afterLine, marker.side); }
      entry.data.lines.forEach((line, index) => { const marker = markers.get(index + 1); fail(line.oldNoNewline === (marker === 'old' || marker === 'both') && line.newNoNewline === (marker === 'new' || marker === 'both')); if (marker) fail(marker === (line.kind === 'add' ? 'new' : line.kind === 'remove' ? 'old' : 'both')); });
    }
    if (entry.kind === 'untracked-file') {
      fail(entry.source.kind === 'filesystem' && entry.comparisonId === null && lossless(entry.data.path, entry.data.pathBytes));
      fail(entry.subject.pathBytes === entry.data.pathBytes);
      if (entry.source.kind === 'filesystem') fail(entry.source.pathBytes === entry.data.pathBytes && entry.source.sha256 === (entry.data.content?.sha256 ?? null) && entry.source.interval.startedAt === repo?.snapshot.startedAt && entry.source.interval.endedAt === repo?.snapshot.endedAt);
      if (entry.data.content?.state === 'collected') {
        const content = entry.data.content; fail(content.bytes !== null && content.text !== null && content.contentId !== null && content.reason === null);
        const raw = Buffer.from(content.bytes!, 'base64'); fail(raw.length === content.byteLength && Buffer.from(content.text!).equals(raw) && !raw.includes(0) && createHash('sha256').update(raw).digest('hex') === content.sha256);
      } else if (entry.data.content) fail(entry.data.content.bytes === null && entry.data.content.text === null && entry.data.content.reason !== null);
    }
    if (entry.kind === 'conflict') fail(entry.source.kind === 'git' && entry.comparisonId === null && entry.subject.pathBytes === entry.data.pathBytes && lossless(entry.data.path, entry.data.pathBytes));
  }
  for (const repo of bundle.repositories) {
    fail(repo.snapshot.startedAt <= repo.snapshot.endedAt);
    if (repo.state === 'failed') fail(repo.repositoryEvidenceId === null && repo.revisions === null && repo.snapshot.snapshotId === null && repo.comparisons.length === 0 && repo.untrackedEvidenceIds.length === 0 && repo.conflictEvidenceIds.length === 0);
    else fail(entries.get(repo.repositoryEvidenceId ?? '')?.kind === 'repository');
    if (repo.state === 'complete') fail(repo.reasons.length === 0 && repo.comparisons.every(comparison => comparison.state === 'complete'));
    for (const comparison of repo.comparisons) { fail(comparison.fileCount === comparison.fileEvidenceIds.length); for (const id of comparison.fileEvidenceIds) { const file = entries.get(id); fail(file?.kind === 'file-change' && file.repositoryId === repo.repositoryId && file.data.comparisonEvidenceId === comparison.evidenceId); } }
    for (const id of repo.untrackedEvidenceIds) fail(entries.get(id)?.kind === 'untracked-file' && entries.get(id)?.repositoryId === repo.repositoryId);
    for (const id of repo.conflictEvidenceIds) fail(entries.get(id)?.kind === 'conflict' && entries.get(id)?.repositoryId === repo.repositoryId);
  }
  fail(bundle.completeness.requestedRepositories === bundle.repositories.length && bundle.completeness.collectedRepositories === bundle.repositories.filter(repo => repo.repositoryEvidenceId !== null).length && bundle.completeness.collectedEvidence === bundle.evidence.length);
  fail(bundle.completeness.repositoryStates.length === bundle.repositories.length && bundle.repositories.every(repo => bundle.completeness.repositoryStates.some(item => item.repositoryId === repo.repositoryId && item.state === repo.state)));
  if (bundle.completeness.state === 'complete') fail(bundle.completeness.reasons.length === 0 && bundle.repositories.every(repo => repo.state === 'complete') && bundle.completeness.omittedCount === 0);
  return bundle;
}
