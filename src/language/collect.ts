import { createHash } from 'node:crypto';
import type { GitAdapter } from '../git/adapter.js';
import type { capture } from '../git/snapshot.js';
import type { FileChange } from '../git/metadata.js';
import type { FilePatch } from '../diff/unified.js';
import { type LanguageAnalyzer, type SourceSnapshot } from './contracts.js';

export async function analyzeFile(adapter: GitAdapter, analyzer: LanguageAnalyzer, file: FileChange, patch: FilePatch, captured: Awaited<ReturnType<typeof capture>>, workingAfter: boolean, budget: { bytes: number; symbols: number }) {
  const sources: { snapshot: SourceSnapshot; bytes: Buffer | null }[] = [];
  for (const side of ['before', 'after'] as const) {
    const before = side === 'before'; const path = before ? file.originalPath : file.destinationPath; const pathBytes = before ? file.originalPathBytes : file.destinationPathBytes;
    const mode = before ? file.oldMode : file.newMode; const oid = before ? file.oldOid : file.newOid; const origin = mode === '000000' ? 'absent' : !before && workingAfter ? 'filesystem' : 'git-blob';
    const snapshot: SourceSnapshot = { side, path, pathBytes, language: analyzer.languageForPath(path), origin, oid: origin === 'git-blob' ? oid : null, sha256: null, byteLength: null, state: 'unavailable', reason: null };
    let bytes: Buffer | null = null;
    if (mode === '000000') bytes = Buffer.alloc(0);
    else if (!snapshot.language) snapshot.reason = 'SYMBOL_LANGUAGE_UNSUPPORTED';
    else if (file.binary || !/^100[0-7]{3}$/u.test(mode)) snapshot.reason = 'SYMBOL_NON_TEXT_FILE';
    else if (origin === 'filesystem') { bytes = captured.trackedContents.get(pathBytes) ?? null; if (!bytes) snapshot.reason = 'SYMBOL_SOURCE_LIMIT'; }
    else if (!oid) snapshot.reason = 'SYMBOL_SOURCE_OID_UNAVAILABLE';
    else {
      try {
        const size = Number((await adapter.required(['cat-file', '-s', oid])).toString('ascii').trim());
        if (!Number.isSafeInteger(size) || size < 0 || size > adapter.limits.maxFileBytes || budget.bytes + size > adapter.limits.maxPatchBytes) snapshot.reason = 'SYMBOL_SOURCE_LIMIT';
        else { const result = await adapter.run(['cat-file', 'blob', oid], undefined, { limit: adapter.limits.maxFileBytes, retainPrefix: false }); if (result.code !== 0 || result.stdout.length !== size) snapshot.reason = 'SYMBOL_SOURCE_READ_FAILED'; else bytes = result.stdout; }
      } catch { snapshot.reason = 'SYMBOL_SOURCE_READ_FAILED'; }
    }
    if (bytes && budget.bytes + bytes.length > adapter.limits.maxPatchBytes) { bytes = null; snapshot.reason = 'SYMBOL_SOURCE_LIMIT'; }
    if (bytes) { budget.bytes += bytes.length; snapshot.state = 'available'; snapshot.byteLength = bytes.length; snapshot.sha256 = createHash('sha256').update(bytes).digest('hex'); }
    sources.push({ snapshot, bytes });
  }
  const result = analyzer.analyze({ sources, patch, maxSymbols: Math.max(0, adapter.limits.maxHunks - budget.symbols) }); budget.symbols += result.symbols.length; return result;
}
