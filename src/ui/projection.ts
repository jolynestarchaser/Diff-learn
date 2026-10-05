import { digest } from '../git/snapshot.js';
import type { ReadEvidenceBundle } from '../evidence/read.js';
import type { UiSession, UiPage, UiEvidence, UiInspection } from './contracts.js';

export class UiRequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function parameters(url: URL, allowed: string[]) {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new UiRequestError(400, 'Unexpected or duplicate query parameter');
}
function page<T>(items: T[], url: URL): UiPage<T> {
  const number = (key: string, fallback: number, maximum: number) => {
    const text = url.searchParams.get(key); if (text === null) return fallback;
    if (!/^\d{1,8}$/u.test(text)) throw new UiRequestError(400, 'Pagination requires bounded integers');
    const value = Number(text); if (value > maximum || key === 'limit' && value < 1) throw new UiRequestError(400, 'Pagination exceeds its bound'); return value;
  };
  const offset = number('offset', 0, 10_000_000), limit = number('limit', 50, 100);
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
}
function id(url: URL, key: string) { const value = url.searchParams.get(key); if (!value || !/^[a-f0-9]{64}$/u.test(value)) throw new UiRequestError(400, 'Expected an original evidence or repository ID'); return value; }

export function createUiProjection(bundle: ReadEvidenceBundle, expiresAt: string) {
  const entries = new Map(bundle.evidence.map(entry => [entry.id, entry]));
  const files = bundle.evidence.filter(entry => entry.kind === 'file-change');
  const hunks = bundle.evidence.filter(entry => entry.kind === 'hunk');
  const syntax = 'languageAnalysis' in bundle ? bundle.languageAnalysis : null;
  const discovery = 'discoveryAnalysis' in bundle ? bundle.discoveryAnalysis : null;
  const session: UiSession = { schemaVersion: bundle.schemaVersion, exportDigest: digest(['ui-export-v1', bundle]), root: bundle.request.root, collection: bundle.collection, scopes: bundle.request.scopes, base: bundle.request.base,
    completeness: bundle.completeness, gitCompleteness: syntax?.gitCompleteness ?? bundle.completeness,
    syntax: { state: syntax?.state ?? 'not-requested', reasons: syntax?.reasons ?? [], languages: syntax?.capabilities.grammars.map(grammar => grammar.language) ?? [] },
    discovery: { references: discovery?.references.state ?? 'not-requested', relatedTests: discovery?.relatedTests.state ?? 'not-requested', history: discovery?.history.state ?? 'not-requested' },
    repositoryCount: bundle.repositories.length, fileCount: files.length, hunkCount: hunks.length, readOnly: true, freshness: 'not-verified', expiresAt };
  return (url: URL): UiSession | UiPage<UiEvidence> | UiPage<ReadEvidenceBundle['repositories'][number]> | UiInspection => {
    const pagination = ['offset', 'limit'];
    if (url.pathname === '/api/session') { parameters(url, []); return session; }
    if (url.pathname === '/api/repositories') { parameters(url, pagination); return page(bundle.repositories, url); }
    if (url.pathname === '/api/files') {
      parameters(url, [...pagination, 'repositoryId', 'q', 'change']); const repositoryId = id(url, 'repositoryId');
      if (!bundle.repositories.some(repository => repository.repositoryId === repositoryId)) throw new UiRequestError(404, 'Repository ID is absent from this export');
      const query = url.searchParams.get('q') ?? ''; if (query.length > 256) throw new UiRequestError(400, 'Path filter exceeds its bound');
      const change = url.searchParams.get('change') ?? ''; if (change && !['A', 'M', 'D', 'R', 'T'].includes(change)) throw new UiRequestError(400, 'Unknown change filter');
      return page(files.filter(file => file.repositoryId === repositoryId && (!change || file.data.status === change) && [file.data.originalPath, file.data.destinationPath].some(path => path?.toLowerCase().includes(query.toLowerCase()))), url);
    }
    if (url.pathname === '/api/hunks') {
      parameters(url, [...pagination, 'fileEvidenceId']); const fileId = id(url, 'fileEvidenceId');
      if (entries.get(fileId)?.kind !== 'file-change') throw new UiRequestError(404, 'File evidence ID is absent from this export');
      return page(hunks.filter(hunk => hunk.data.fileEvidenceId === fileId), url);
    }
    if (url.pathname === '/api/inspect') {
      parameters(url, [...pagination, 'evidenceId']); const evidenceId = id(url, 'evidenceId'), entry = entries.get(evidenceId);
      if (!entry) throw new UiRequestError(404, 'Evidence ID is absent from this export');
      const fileId = entry.kind === 'file-change' ? entry.id : 'fileEvidenceId' in entry.data ? entry.data.fileEvidenceId : null;
      const file = fileId ? entries.get(fileId) : null;
      const related = bundle.evidence.filter(other => other.id !== entry.id && other.kind !== 'hunk' && fileId !== null && ('fileEvidenceId' in other.data && other.data.fileEvidenceId === fileId || other.id === fileId) && (entry.kind !== 'hunk' || other.kind !== 'symbol' || other.data.hunkEvidenceIds.includes(entry.id)));
      const repository = bundle.repositories.find(item => item.repositoryId === entry.repositoryId);
      const diagnostics = bundle.diagnostics.filter(diagnostic => diagnostic.repositoryId === null || diagnostic.repositoryId === entry.repositoryId && (diagnostic.path === null || diagnostic.path === repository?.path || file?.kind === 'file-change' && (diagnostic.path === file.data.destinationPath || diagnostic.path === file.data.originalPath)));
      return { entry, related: page(related, url), completeness: bundle.completeness, diagnostics };
    }
    throw new UiRequestError(404, 'No such read-only endpoint');
  };
}
