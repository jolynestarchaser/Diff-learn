import path from 'node:path';
import { ScanError } from '../config/load.js';
import { validateBundle, type EvidenceBundle } from './schema.js';
import { validateSyntaxBundle, type SyntaxBundle } from './syntax.js';
import { validateCandidateBundle, type CandidateBundle } from './candidates.js';
import { validateJavaSyntaxBundle, type JavaSyntaxBundle } from './java-syntax.js';
import { readBoundedJson } from '../review/store.js';
import { reviewLimits } from '../review/schema.js';

export type ReadEvidenceBundle = EvidenceBundle | SyntaxBundle | CandidateBundle | JavaSyntaxBundle;
export function readEvidenceBundle(value: unknown): ReadEvidenceBundle {
  const version = value && typeof value === 'object' && 'schemaVersion' in value ? value.schemaVersion : null;
  switch (version) {
    case '1.0.0': return validateBundle(value);
    case '1.1.0': return validateSyntaxBundle(value);
    case '1.2.0': return validateCandidateBundle(value);
    case '1.3.0': return validateJavaSyntaxBundle(value);
    default: throw new ScanError('EVIDENCE_VERSION_UNSUPPORTED', 'Supported evidence versions: 1.0.0, 1.1.0, 1.2.0 and 1.3.0', 2);
  }
}
export async function loadEvidenceBundle(filename: string): Promise<ReadEvidenceBundle> {
  return readEvidenceBundle(await readBoundedJson(path.resolve(filename), reviewLimits.maxEvidenceBytes, 'EVIDENCE_INVALID'));
}
