import { z } from 'zod';
import { ScanError } from '../config/load.js';
import { javaLanguageCapabilities } from '../language/contracts.js';
import type { RepositoryStatus } from '../git/collector.js';
import { evidenceSchema, outputSchema, type EvidenceBundle } from './schema.js';
import { syntaxEvidenceSchema, syntaxBundleSchema, syntaxSource, languageResultSchema, capabilitiesSchema, buildSyntaxExtension, validateSyntaxFacts } from './syntax.js';

const language = z.enum(['typescript', 'tsx', 'javascript', 'java']);
const historicalSymbol = languageResultSchema.shape.symbols.element;
const symbol = historicalSymbol.extend({ language, kind: z.enum([...historicalSymbol.shape.kind.options, 'package', 'record', 'record-component', 'enum-constant', 'annotation-type', 'annotation-element', 'annotation', 'constructor', 'field', 'initializer', 'anonymous-class', 'lambda']), signatureDisplay: z.string().optional() });
export const javaLanguageResultSchema = languageResultSchema.extend({ sources: z.array(languageResultSchema.shape.sources.element.extend({ language: language.nullable() })).length(2), symbols: z.array(symbol) });
const historicalAnalysis = syntaxEvidenceSchema.options.find(entry => entry.shape.kind.value === 'language-analysis')!;
const historicalSymbolEntry = syntaxEvidenceSchema.options.find(entry => entry.shape.kind.value === 'symbol')!;
// Shared common anchors are unchanged; Java owns the expanded data contracts.
const analysisEntry = z.strictObject({ ...historicalAnalysis.shape, kind: z.literal('language-analysis'), source: syntaxSource, data: javaLanguageResultSchema.omit({ symbols: true }).extend({ fileEvidenceId: z.string().regex(/^[a-f0-9]{64}$/u), symbolCount: z.number().int().nonnegative() }) });
const symbolEntry = z.strictObject({ ...historicalSymbolEntry.shape, kind: z.literal('symbol'), source: syntaxSource, data: symbol.extend({ fileEvidenceId: z.string().regex(/^[a-f0-9]{64}$/u), analysisEvidenceId: z.string().regex(/^[a-f0-9]{64}$/u), hunkEvidenceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u) }) });
export const javaSyntaxEvidenceSchema = z.discriminatedUnion('kind', [...evidenceSchema.options, analysisEntry, symbolEntry]);
export const javaSyntaxBundleSchema = syntaxBundleSchema.extend({ schemaVersion: z.literal('1.3.0'), evidence: z.array(javaSyntaxEvidenceSchema), languageAnalysis: syntaxBundleSchema.shape.languageAnalysis.extend({ capabilities: capabilitiesSchema.extend({ grammars: z.array(z.strictObject({ language, package: z.string(), version: z.string() })).length(4) }) }) });
export const javaSyntaxOutputSchema = z.union([outputSchema, javaSyntaxBundleSchema]);
export type JavaSyntaxBundle = z.infer<typeof javaSyntaxBundleSchema>;
export type JavaSyntaxEvidence = z.infer<typeof javaSyntaxEvidenceSchema>;
export function validateJavaSyntaxBundle(value: unknown): JavaSyntaxBundle {
  const result = javaSyntaxBundleSchema.safeParse(value);
  if (!result.success) throw new ScanError('INTERNAL_CONTRACT_ERROR', 'Java syntax evidence violated schema 1.3.0', 1);
  for (const entry of result.data.evidence) if (entry.kind === 'symbol' && entry.data.language !== 'java' && (!historicalSymbol.shape.kind.options.includes(entry.data.kind as typeof historicalSymbol.shape.kind.options[number]) || entry.data.signatureDisplay !== undefined)) throw new ScanError('INTERNAL_CONTRACT_ERROR', 'Java declaration kinds/signatures require the Java language profile', 1);
  validateSyntaxFacts(result.data, javaLanguageCapabilities); return result.data;
}
export function extendJavaSyntaxBundle(base: EvidenceBundle, repositories: RepositoryStatus[]): JavaSyntaxBundle {
  return validateJavaSyntaxBundle(buildSyntaxExtension(base, repositories, { schemaVersion: '1.3.0', capabilities: javaLanguageCapabilities, resultSchema: javaLanguageResultSchema }));
}
