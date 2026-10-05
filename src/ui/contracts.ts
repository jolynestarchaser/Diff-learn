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
  readOnly: true; freshness: 'not-verified'; expiresAt: string;
};
export type UiInspection = { entry: UiEvidence; related: UiPage<UiEvidence>; diagnostics: ReadEvidenceBundle['diagnostics']; completeness: ReadEvidenceBundle['completeness'] };
