import { z } from 'zod';
import { ScanError } from '../config/load.js';
import { digest } from '../git/snapshot.js';
import type { RepositoryStatus } from '../git/collector.js';
import { languageCapabilities, type LanguageResult } from '../language/contracts.js';
import { bundleSchema, evidenceSchema, validateBundle, unsupportedAnalysis, outputSchema, type EvidenceBundle } from './schema.js';

const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER); const positive = uint.min(1); const hash = z.string().regex(/^[a-f0-9]{64}$/u); const language = z.enum(['typescript', 'tsx', 'javascript']);
const code = z.string().regex(/^[A-Z][A-Z0-9_]*$/u); const bytes = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u); const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const rangeSchema = z.strictObject({ startByte: uint, endByte: uint, startLine: positive, endLine: positive, startColumn: uint, endColumn: uint });
const diagnostic = z.strictObject({ code, side: z.enum(['before', 'after']).nullable(), range: rangeSchema.nullable(), message: z.string() });
const source = z.strictObject({ side: z.enum(['before', 'after']), path: z.string().nullable(), pathBytes: bytes.min(1), language: language.nullable(), origin: z.enum(['git-blob', 'filesystem', 'absent']), oid: oid.nullable(), sha256: hash.nullable(), byteLength: uint.nullable(), state: z.enum(['available', 'unavailable']), reason: code.nullable() });
const symbol = z.strictObject({ ordinal: positive, side: z.enum(['before', 'after']), language, kind: z.enum(['class', 'method', 'function', 'arrow-function', 'variable', 'interface', 'type-alias', 'enum', 'namespace', 'import', 'top-level']), name: z.string().nullable(), scope: z.array(z.strictObject({ kind: z.string(), name: z.string().nullable() })), range: rangeSchema, contentHash: hash, hunkOrdinals: z.array(positive).min(1), matching: z.enum(['candidate', 'unmatched', 'ambiguous', 'not-applicable']), counterpartOrdinal: positive.nullable() });
export const languageResultSchema = z.strictObject({ state: z.enum(['complete', 'partial', 'unavailable']), reasons: z.array(code), sources: z.array(source).length(2), symbols: z.array(symbol), diagnostics: z.array(diagnostic), unmappedChangedLines: uint, omittedSymbols: uint, changeInterpretation: z.literal('syntax-only'), references: z.literal('unavailable'), behavior: z.literal('unavailable'), contracts: z.literal('unavailable') });
const syntaxSource = z.strictObject({ kind: z.literal('syntax-parser'), method: z.literal('containing-declarations'), executed: z.boolean(), runtime: z.literal('0.21.1'), grammarAbi: z.literal(14), contentHashes: z.array(hash), originatingEvidenceIds: z.array(hash) });
const common = evidenceSchema.options[0].shape;
const analysisEntry = z.strictObject({ ...common, kind: z.literal('language-analysis'), data: languageResultSchema.omit({ symbols: true }).extend({ fileEvidenceId: hash, symbolCount: uint }), source: syntaxSource });
const symbolEntry = z.strictObject({ ...common, kind: z.literal('symbol'), data: symbol.extend({ fileEvidenceId: hash, analysisEvidenceId: hash, hunkEvidenceIds: z.array(hash).min(1), sourceSha256: hash }), source: syntaxSource });
export const syntaxEvidenceSchema = z.discriminatedUnion('kind', [...evidenceSchema.options, analysisEntry, symbolEntry]);
export type SyntaxEvidence = z.infer<typeof syntaxEvidenceSchema>;
const capabilities = z.strictObject({ analyzer: z.literal('tree-sitter'), runtime: z.literal('0.21.1'), grammarAbi: z.literal(14), grammars: z.array(z.strictObject({ language, package: z.string(), version: z.string() })).length(3), declarations: z.literal(true), imports: z.literal(true), topLevel: z.literal(true), syntacticMatching: z.literal(true), semanticReferences: z.literal(false), typeChecking: z.literal(false), inferredBehavior: z.literal(false), inferredContracts: z.literal(false), maxNodes: z.literal(100000), parseTimeoutMs: z.literal(250) });
export const syntaxBundleSchema = bundleSchema.extend({ schemaVersion: z.literal('1.1.0'), evidence: z.array(syntaxEvidenceSchema), analysis: z.strictObject({ policy: z.literal('git-and-syntax-facts'), unsupported: z.array(z.enum(unsupportedAnalysis.filter(kind => kind !== 'changed-symbols'))) }), languageAnalysis: z.strictObject({ requested: z.literal(true), capabilities, state: z.enum(['complete', 'partial', 'unavailable']), reasons: z.array(code), filesRequested: uint, filesAnalyzed: uint, omittedFiles: uint, evidenceIds: z.array(hash), limits: z.strictObject({ maxSourceBytes: positive, maxSymbols: positive, maxNodes: z.literal(100000), parseTimeoutMs: z.literal(250) }), gitCompleteness: bundleSchema.shape.completeness.pick({ state: true, reasons: true, omittedCount: true }) }) });
export type SyntaxBundle = z.infer<typeof syntaxBundleSchema>;
export const syntaxOutputSchema = z.union([outputSchema, syntaxBundleSchema]);
export function syntaxId(entry: Pick<SyntaxEvidence, 'repositoryId' | 'snapshotId' | 'comparisonId' | 'kind' | 'subject' | 'data'>) { return digest(['evidence-v1', entry.repositoryId, entry.comparisonId ?? entry.snapshotId, entry.kind, entry.subject, entry.data]); }
export function validateSyntaxBundle(value: unknown): SyntaxBundle {
  const parsed = syntaxBundleSchema.safeParse(value); if (!parsed.success) throw new ScanError('INTERNAL_CONTRACT_ERROR', 'Syntax evidence violated its runtime schema', 1);
  const bundle = parsed.data; const syntax = bundle.evidence.filter(entry => entry.kind === 'symbol' || entry.kind === 'language-analysis'); const base = bundle.evidence.filter(entry => entry.kind !== 'symbol' && entry.kind !== 'language-analysis');
  const { languageAnalysis: _language, ...projection } = bundle;
  validateBundle({ ...projection, schemaVersion: '1.0.0', evidence: base, analysis: { policy: 'git-facts-only', unsupported: [...unsupportedAnalysis] }, completeness: { ...bundle.completeness, ...bundle.languageAnalysis.gitCompleteness, collectedEvidence: base.length } });
  const entries = new Map(bundle.evidence.map(entry => [entry.id, entry])); const fail = (condition: unknown) => { if (!condition) throw new ScanError('INTERNAL_CONTRACT_ERROR', 'Syntax evidence references or coverage violated the contract', 1); };
  const byAnalysis = new Map<string, Extract<SyntaxEvidence, { kind: 'symbol' }>[]>(); const byOrdinal = new Map<string, Extract<SyntaxEvidence, { kind: 'symbol' }>>();
  for (const entry of syntax) if (entry.kind === 'symbol') { const key = JSON.stringify([entry.data.analysisEvidenceId, entry.data.ordinal]); fail(!byOrdinal.has(key)); byOrdinal.set(key, entry); const group = byAnalysis.get(entry.data.analysisEvidenceId) ?? []; group.push(entry); byAnalysis.set(entry.data.analysisEvidenceId, group); }
  fail(entries.size === bundle.evidence.length && digest(bundle.languageAnalysis.capabilities) === digest(languageCapabilities));
  fail(bundle.completeness.collectedEvidence === bundle.evidence.length && digest(bundle.languageAnalysis.evidenceIds) === digest(syntax.map(entry => entry.id)));
  fail(bundle.languageAnalysis.filesRequested === base.filter(entry => entry.kind === 'file-change').length);
  fail(bundle.languageAnalysis.omittedFiles + syntax.filter(entry => entry.kind === 'language-analysis').length === bundle.languageAnalysis.filesRequested);
  fail(bundle.languageAnalysis.limits.maxSourceBytes === bundle.request.limits.maxPatchBytes && bundle.languageAnalysis.limits.maxSymbols === bundle.request.limits.maxHunks);
  fail(bundle.analysis.unsupported.length === unsupportedAnalysis.length - 1 && unsupportedAnalysis.filter(kind => kind !== 'changed-symbols').every(kind => bundle.analysis.unsupported.includes(kind)));
  for (const entry of syntax) {
    fail(entry.id === syntaxId(entry)); const parent = entries.get(entry.data.fileEvidenceId); fail(parent?.kind === 'file-change' && parent.repositoryId === entry.repositoryId && parent.snapshotId === entry.snapshotId && parent.comparisonId === entry.comparisonId);
    fail(entry.subject.pathBytes === parent?.subject.pathBytes && entry.subject.originalPathBytes === parent?.subject.originalPathBytes);
    fail(entry.source.originatingEvidenceIds.includes(entry.data.fileEvidenceId));
    for (const id of entry.source.originatingEvidenceIds) { const origin = entries.get(id); fail(origin && origin.repositoryId === entry.repositoryId && origin.snapshotId === entry.snapshotId && origin.id !== entry.id); }
    if (entry.kind === 'language-analysis') {
      fail(entry.data.sources[0]?.side === 'before' && entry.data.sources[1]?.side === 'after');
      if (parent?.kind === 'file-change') {
        const before = entry.data.sources[0]!, after = entry.data.sources[1]!; fail(before.path === parent.data.originalPath && before.pathBytes === parent.data.originalPathBytes && after.path === parent.data.destinationPath && after.pathBytes === parent.data.destinationPathBytes);
        fail(before.origin === (parent.data.oldMode === '000000' ? 'absent' : 'git-blob')); fail(after.origin === (parent.data.newMode === '000000' ? 'absent' : bundle.request.scopes[0] === 'branch' || bundle.request.scopes[0] === 'staged' ? 'git-blob' : 'filesystem'));
        if (before.origin === 'git-blob') fail(before.oid === parent.data.oldOid); if (after.origin === 'git-blob') fail(after.oid === parent.data.newOid);
      }
      for (const source of entry.data.sources) { fail(source.state === 'available' ? source.sha256 !== null && source.byteLength !== null && source.reason === null : source.reason !== null); fail(source.origin !== 'filesystem' || source.oid === null); }
      fail(digest(entry.source.contentHashes) === digest(entry.data.sources.flatMap(source => source.sha256 ? [source.sha256] : [])));
      const symbols = byAnalysis.get(entry.id) ?? []; fail(symbols.length === entry.data.symbolCount);
      fail(entry.data.state !== 'complete' || entry.data.reasons.length === 0 && entry.data.omittedSymbols === 0 && entry.data.unmappedChangedLines === 0 && entry.data.sources.every(source => source.state === 'available'));
    } else {
      const analysis = entries.get(entry.data.analysisEvidenceId); fail(analysis?.kind === 'language-analysis' && analysis.data.fileEvidenceId === entry.data.fileEvidenceId);
      fail(entry.source.originatingEvidenceIds.includes(entry.data.analysisEvidenceId) && entry.data.hunkEvidenceIds.every(id => entry.source.originatingEvidenceIds.includes(id)));
      const source = analysis?.kind === 'language-analysis' ? analysis.data.sources.find(item => item.side === entry.data.side) : null;
      fail(source?.state === 'available' && source.sha256 === entry.data.sourceSha256 && source.language === entry.data.language && entry.data.range.endByte <= source.byteLength!);
      fail(entry.data.range.startByte <= entry.data.range.endByte && entry.data.range.startLine <= entry.data.range.endLine && entry.subject.ordinal === entry.data.ordinal);
      fail(entry.data.hunkEvidenceIds.length === entry.data.hunkOrdinals.length);
      entry.data.hunkEvidenceIds.forEach((id, index) => { const hunk = entries.get(id); fail(hunk?.kind === 'hunk' && hunk.data.fileEvidenceId === entry.data.fileEvidenceId && hunk.data.ordinal === entry.data.hunkOrdinals[index]); });
      if (entry.data.matching !== 'candidate') fail(entry.data.counterpartOrdinal === null);
      else { const other = byOrdinal.get(JSON.stringify([entry.data.analysisEvidenceId, entry.data.counterpartOrdinal])); fail(other && other.data.side !== entry.data.side && other.data.counterpartOrdinal === entry.data.ordinal && other.data.name === entry.data.name && other.data.kind === entry.data.kind && other.data.language === entry.data.language && digest(other.data.scope) === digest(entry.data.scope)); }
    }
  }
  fail(bundle.languageAnalysis.filesAnalyzed === syntax.filter(entry => entry.kind === 'language-analysis' && entry.data.state !== 'unavailable').length);
  if (bundle.languageAnalysis.state === 'complete') fail(bundle.languageAnalysis.reasons.length === 0 && bundle.languageAnalysis.omittedFiles === 0 && bundle.languageAnalysis.filesAnalyzed === bundle.languageAnalysis.filesRequested && syntax.every(entry => entry.kind !== 'language-analysis' || entry.data.state === 'complete'));
  if (bundle.languageAnalysis.state === 'unavailable') fail(bundle.languageAnalysis.filesAnalyzed === 0 && bundle.languageAnalysis.reasons.length > 0);
  return bundle;
}
export function extendSyntaxBundle(base: EvidenceBundle, repositories: RepositoryStatus[]): SyntaxBundle {
  const evidence: SyntaxEvidence[] = [...base.evidence]; const reasons = new Set<string>();
  const raw = new Map(repositories.flatMap(repo => repo.comparisons.flatMap(comparison => comparison.files.map(file => [JSON.stringify([repo.repositoryId, comparison.comparisonId, file.originalPathBytes, file.destinationPathBytes]), file.languageAnalysis] as const))));
  const hunks = new Map(base.evidence.filter(entry => entry.kind === 'hunk').map(entry => [JSON.stringify([entry.data.fileEvidenceId, entry.data.ordinal]), entry]));
  const diagnostics = [...base.diagnostics]; const files = base.evidence.filter(entry => entry.kind === 'file-change');
  for (const repo of repositories) if (repo.diagnostics.some(item => item.code === 'SYMBOL_RUNTIME_UNAVAILABLE')) reasons.add('SYMBOL_RUNTIME_UNAVAILABLE');
  for (const file of files) {
    const original = raw.get(JSON.stringify([file.repositoryId, file.comparisonId, file.data.originalPathBytes, file.data.destinationPathBytes])); if (!original) { reasons.add('SYMBOL_COLLECTION_UNAVAILABLE'); continue; }
    const result = languageResultSchema.parse(structuredClone(original)); const kept = result.symbols.filter(symbol => symbol.hunkOrdinals.every(ordinal => hunks.has(JSON.stringify([file.id, ordinal]))));
    if (kept.length !== result.symbols.length) { result.omittedSymbols += result.symbols.length - kept.length; result.reasons.push('SYMBOL_OUTPUT_LIMIT'); result.state = kept.length ? 'partial' : 'unavailable'; }
    for (const symbol of kept) if (symbol.counterpartOrdinal !== null && !kept.some(item => item.ordinal === symbol.counterpartOrdinal)) { symbol.counterpartOrdinal = null; symbol.matching = 'unmatched'; }
    const { symbols: _symbols, ...summary } = result; result.reasons.forEach(reason => reasons.add(reason));
    for (const diagnostic of result.diagnostics) diagnostics.push({ code: diagnostic.code, severity: 'warning', stage: 'collection', repositoryId: file.repositoryId, scope: base.request.scopes[0]!, path: file.data.destinationPath, message: diagnostic.message });
    const source = { kind: 'syntax-parser' as const, method: 'containing-declarations' as const, executed: result.sources.some(source => source.state === 'available' && source.origin !== 'absent'), runtime: '0.21.1' as const, grammarAbi: 14 as const, contentHashes: result.sources.flatMap(source => source.sha256 ? [source.sha256] : []), originatingEvidenceIds: [file.id] };
    const anchor = { repositoryId: file.repositoryId, snapshotId: file.snapshotId, comparisonId: file.comparisonId, confidence: 'fact' as const, subject: { ...file.subject } };
    const analysis = { ...anchor, kind: 'language-analysis' as const, data: { ...summary, fileEvidenceId: file.id, symbolCount: kept.length }, source }; const analysisId = syntaxId(analysis); evidence.push({ ...analysis, id: analysisId });
    for (const symbol of kept) {
      const entry = { ...anchor, kind: 'symbol' as const, subject: { ...file.subject, ordinal: symbol.ordinal }, data: { ...symbol, fileEvidenceId: file.id, analysisEvidenceId: analysisId, hunkEvidenceIds: symbol.hunkOrdinals.map(ordinal => hunks.get(JSON.stringify([file.id, ordinal]))!.id), sourceSha256: result.sources.find(source => source.side === symbol.side)!.sha256! }, source: { ...source, originatingEvidenceIds: [analysisId, file.id, ...symbol.hunkOrdinals.map(ordinal => hunks.get(JSON.stringify([file.id, ordinal]))!.id)] } };
      evidence.push({ ...entry, id: syntaxId(entry) });
    }
  }
  if (base.completeness.state !== 'complete') reasons.add('SYMBOL_GIT_COVERAGE_INCOMPLETE');
  const create = (entries: SyntaxEvidence[], omittedFiles: number): SyntaxBundle => {
    const analyzed = entries.filter(entry => entry.kind === 'language-analysis' && entry.data.state !== 'unavailable').length;
    const state = reasons.size === 0 ? 'complete' : analyzed ? 'partial' : 'unavailable';
    return { ...base, schemaVersion: '1.1.0', evidence: entries, diagnostics, analysis: { policy: 'git-and-syntax-facts', unsupported: unsupportedAnalysis.filter(kind => kind !== 'changed-symbols') }, languageAnalysis: { requested: true, capabilities: languageCapabilities, state, reasons: [...reasons].sort(), filesRequested: files.length, filesAnalyzed: analyzed, omittedFiles, evidenceIds: entries.filter(entry => entry.kind === 'language-analysis' || entry.kind === 'symbol').map(entry => entry.id), limits: { maxSourceBytes: base.request.limits.maxPatchBytes, maxSymbols: base.request.limits.maxHunks, maxNodes: 100000, parseTimeoutMs: 250 }, gitCompleteness: { state: base.completeness.state, reasons: base.completeness.reasons, omittedCount: base.completeness.omittedCount } }, completeness: { ...base.completeness, state: base.completeness.state === 'failed' ? 'failed' : state !== 'complete' ? 'partial' : base.completeness.state, reasons: [...new Set([...base.completeness.reasons, ...reasons])].sort(), collectedEvidence: entries.length, omittedCount: state === 'complete' ? base.completeness.omittedCount : null } };
  };
  let bundle = create(evidence, files.length - evidence.filter(entry => entry.kind === 'language-analysis').length);
  if (Buffer.byteLength(JSON.stringify(bundle)) > base.request.limits.maxBundleBytes) { reasons.add('SYMBOL_OUTPUT_LIMIT'); diagnostics.push({ code: 'SYMBOL_OUTPUT_LIMIT', severity: 'warning', stage: 'export', repositoryId: null, scope: base.request.scopes[0]!, path: null, message: 'Whole syntax evidence omitted at maxBundleBytes; Git evidence retained' }); bundle = create([...base.evidence], files.length); }
  if (Buffer.byteLength(JSON.stringify(bundle)) > base.request.limits.maxBundleBytes) throw new ScanError('BUNDLE_LIMIT', 'Minimal syntax extension exceeds maxBundleBytes', 1);
  return validateSyntaxBundle(bundle);
}
