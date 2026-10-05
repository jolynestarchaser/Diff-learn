import type { ReadEvidenceBundle } from '../evidence/read.js';

export type UiEvidence = ReadEvidenceBundle['evidence'][number];
export type UiFile = Extract<UiEvidence, { kind: 'file-change' }>;
export type UiHunk = Extract<UiEvidence, { kind: 'hunk' }>;
export type UiRepository = ReadEvidenceBundle['repositories'][number];
export type UiPage<T> = { items: T[]; total: number; offset: number; limit: number };
export type UiSession = {
  schemaVersion: ReadEvidenceBundle['schemaVersion']; exportDigest: string;
  root: string; collection: ReadEvidenceBundle['collection']; scopes: string[]; base: string | null;
  completeness: ReadEvidenceBundle['completeness']; gitCompleteness: { state: string; reasons: string[] };
  syntax: { state: string; reasons: string[]; languages: string[] };
  discovery: { references: string; relatedTests: string; history: string };
  repositoryCount: number; fileCount: number; hunkCount: number;
  readOnly: true; freshness: 'not-verified'; expiresAt: string | null;
};
export type UiAppState = {
  mode: 'export' | 'repository'; phase: 'loading' | 'ready' | 'refreshing' | 'error';
  root: string; branch: string | null; scope: string; generation: number;
  snapshot: UiSession | null; error: { code: string; message: string } | null;
  reviewSelection?: ReviewSelection;
  outgoing?: OutgoingReview | null;
};
export type ReviewSelection = { mode: 'uncommitted' | 'unpushed'; commit: string | null; comparisonRef?: string };
export type OutgoingCommit = { oid: string; shortOid: string; subject: string; author: string; date: string; parents: string[]; unavailableReason: string | null };
export type OutgoingReview = {
  head: string | null; branch: string | null; detached: boolean; shallow: boolean;
  comparison: { ref: string; oid: string; kind: 'upstream' | 'chosen' } | null;
  upstreamRef: string | null; refs: { ref: string; oid: string }[];
  status: 'ready' | 'empty' | 'unborn' | 'detached' | 'no-upstream' | 'missing-upstream';
  ahead: number | null; behind: number | null; diverged: boolean;
  commits: OutgoingCommit[]; complete: boolean; omittedCommits: number;
  mergeBases: string[]; aggregateReason: string | null; capturedAt: string;
};
export type UiInspection = { entry: UiEvidence; related: UiPage<UiEvidence>; diagnostics: ReadEvidenceBundle['diagnostics']; completeness: ReadEvidenceBundle['completeness'] };
