import path from 'node:path';
import type { Command } from 'commander';
import { ScanError } from '../config/load.js';
import { canonicalRoot } from '../git/discovery.js';
import { digest } from '../git/snapshot.js';
import { readEvidenceBundle } from '../evidence/read.js';
import { listReview, markReview, type ReviewBundle } from '../review/matching.js';
import { emptyReviewState, reviewLimits, reviewReportSchema, type ReviewReport } from '../review/schema.js';
import { readBoundedJson, readReviewState, mutateReviewState, reviewStateFile } from '../review/store.js';
import { messages, type Locale } from '../output/locale.js';

async function readEvidence(filename: string, root: string): Promise<ReviewBundle> {
  let value: unknown;
  try { value = await readBoundedJson(path.resolve(filename), reviewLimits.maxEvidenceBytes, 'REVIEW_EVIDENCE_INVALID'); }
  catch (error) { if (error instanceof ScanError) throw error; throw new ScanError('REVIEW_EVIDENCE_READ', 'Cannot read the supplied evidence file', 1); }
  let bundle: ReviewBundle;
  try {
    bundle = readEvidenceBundle(value);
  } catch { throw new ScanError('REVIEW_EVIDENCE_INVALID', 'Expected a validated evidence bundle version 1.0.0, 1.1.0, 1.2.0 or 1.3.0, with intact IDs and parent references', 2); }
  if (await canonicalRoot(bundle.request.root) !== root) throw new ScanError('REVIEW_ROOT_MISMATCH', '--root must match the exported evidence workspace; recollect evidence after moving a workspace', 2);
  return bundle;
}
function human(report: ReviewReport, locale: Locale): string {
  const th = locale === 'th';
  const lines = [th ? 'สถานะการตรวจทาน difflearn (การยืนยันโดยผู้ใช้ ไม่ใช่การรับรองความถูกต้อง)' : 'difflearn review (human acknowledgment, not a correctness claim)', `${th ? 'ไฟล์สถานะ' : 'State file'}: ${JSON.stringify(report.stateFile)}`, `${th ? 'การดำเนินการ' : 'Operation'}: ${report.operation}; ${report.completeness.state}`];
  if (report.operation === 'reset') lines.push(`${th ? 'ลบการยืนยันแล้ว' : 'Acknowledgments removed'}: ${report.removedAcknowledgments ?? (th ? 'ไม่ทราบจำนวน' : 'unknown')}`);
  if (report.operation === 'mark') lines.push(`${th ? 'ยืนยัน hunk แล้ว' : 'Hunks explicitly marked'}: ${report.markedHunkEvidenceIds.length}`);
  const labels = { unseen: th ? 'ยังไม่ตรวจทาน' : 'unseen', reviewed: th ? 'ตรวจทานแล้ว' : 'reviewed', 'changed-since-reviewed': th ? 'เปลี่ยนหลังตรวจทาน' : 'changed-since-reviewed' };
  for (const row of report.rows) lines.push(`${labels[row.status]}: ${JSON.stringify(row.path ?? { pathBytes: row.pathBytes })} [${row.scope}] ${row.reason}\n  hunk=${row.hunkEvidenceId} snapshot=${row.snapshotId}\n  comparison=${row.comparisonId}${row.acknowledgment ? ` acknowledgment=${row.acknowledgment.id} reviewed-snapshot=${row.acknowledgment.snapshotId}` : ''}`);
  if (!report.rows.length && report.operation !== 'reset') lines.push(th ? 'ไม่มี hunk ที่เก็บรวบรวมในหลักฐานนี้ ตรวจสอบความครบถ้วนก่อนสรุป' : 'No collected hunks in this evidence; check completeness before drawing conclusions.');
  return `${lines.join('\n')}\n`;
}
type Options = { root?: string; evidence?: string; snapshot?: string; hunk?: string[]; lang?: string; json?: boolean };
export function registerReview(program: Command, signal: AbortSignal): void {
  const review = program.command('review').description('Explicit local hunk acknowledgments, separate from evidence; never a correctness claim');
  review.addHelpText('after', '\nmark/list require an exported concrete evidence bundle; neither command collects Git data.\nState: <root>/.difflearn/review-state.json. Only mark/reset write it.');
  for (const operation of ['mark', 'list', 'reset'] as const) {
    const command = review.command(operation).description(operation === 'mark' ? 'Explicitly acknowledge selected hunks in one concrete evidence snapshot' : operation === 'list' ? 'Compare collected hunks with local acknowledgments conservatively (read-only)' : 'Explicitly discard all local acknowledgments, including invalid/version-incompatible state')
      .option('--root <directory>', 'workspace directory owning state (default cwd)')
      .option('--lang <locale>', 'human output: en or th (default en)')
      .option('--json', 'emit one English-keyed review report');
    if (operation !== 'reset') command.requiredOption('--evidence <file>', 'explicit exported evidence JSON (1.0.0 / 1.1.0 / 1.2.0 / 1.3.0)');
    if (operation === 'mark') command.requiredOption('--snapshot <id>', 'exact repository snapshot ID in the evidence')
      .requiredOption('--hunk <id>', 'exact hunk evidence ID (repeatable)', (value: string, previous: string[]) => [...previous, value], []);
    command.action(async (options: Options) => {
      const flags = new Set<string>();
      for (const argument of process.argv.slice(4)) {
        const flag = argument.split('=')[0]!;
        if (['--root', '--lang', '--json', '--evidence', '--snapshot'].includes(flag)) { if (flags.has(flag)) throw new ScanError('ARGUMENT_INVALID', `Duplicate scalar flag ${flag}`, 2); flags.add(flag); }
      }
      const locale = options.lang ?? 'en';
      if (locale !== 'en' && locale !== 'th') throw new ScanError('ARGUMENT_INVALID', '--lang must be en or th', 2);
      const root = await canonicalRoot(options.root ?? process.cwd());
      const bundle = operation === 'reset' ? null : await readEvidence(options.evidence!, root);
      signal.throwIfAborted();
      const diagnostics: ReviewReport['diagnostics'] = [];
      let writePending = false;
      let rows: ReviewReport['rows'] = [], presence: ReviewReport['statePresence'], removed: number | null = 0;
      if (operation === 'list') {
        const loaded = await readReviewState(root); presence = loaded.presence; writePending = loaded.writePending; rows = listReview(bundle!, loaded.state);
      } else {
        // Validate all targets against empty state before creating any state directory.
        if (operation === 'mark') markReview(bundle!, emptyReviewState(), options.snapshot!, options.hunk ?? []);
        const written = await mutateReviewState(root, (state, discarded) => {
          if (operation === 'reset') { removed = discarded ? null : state.acknowledgments.length; if (discarded) diagnostics.push({ code: discarded, severity: 'warning', message: 'Explicit reset discarded invalid/incompatible state; its acknowledgment count is unknown' }); return emptyReviewState(); }
          return markReview(bundle!, state, options.snapshot!, options.hunk ?? []);
        }, { resetInvalid: operation === 'reset', signal });
        presence = 'written'; if (bundle) rows = listReview(bundle, written.state);
      }
      const reasons = bundle?.completeness.state !== 'complete' && bundle !== null ? ['REVIEW_EVIDENCE_PARTIAL'] : [];
      if (reasons.length) diagnostics.push({ code: 'REVIEW_EVIDENCE_PARTIAL', severity: 'warning', message: 'Input evidence has incomplete coverage; absent hunks are not claimed reviewed' });
      if (writePending) { reasons.push('REVIEW_STATE_LOCK_PRESENT'); diagnostics.push({ code: 'REVIEW_STATE_LOCK_PRESENT', severity: 'warning', message: 'A writer lock exists; only the last committed state was read. Temporary files are ignored; do not remove the lock until its writer is confirmed stopped' }); }
      if (rows.some(row => row.reason === 'AMBIGUOUS_HUNKS')) diagnostics.push({ code: 'REVIEW_MATCH_AMBIGUOUS', severity: 'warning', message: 'Identical or competing hunks remain unseen; no review status was inherited' });
      const report = reviewReportSchema.parse({ schemaVersion: '1.0.0', reportKind: 'review', operation, stateFile: reviewStateFile(root), statePresence: presence, matchingPolicy: 'conservative-byte-content-v1', evidenceDigest: bundle ? digest(['review-input-v1', bundle.schemaVersion, bundle.evidence.map(entry => entry.id)]) : null, inputCompleteness: bundle?.completeness.state ?? null, rows, markedHunkEvidenceIds: operation === 'mark' ? options.hunk : [], removedAcknowledgments: removed, completeness: { state: reasons.length ? 'partial' : 'complete', reasons }, diagnostics, interpretation: 'explicit-human-acknowledgment-not-correctness' });
      for (const diagnostic of report.diagnostics) process.stderr.write(`${messages(locale).warning} [${diagnostic.code}]: ${JSON.stringify(diagnostic.message)}\n`);
      process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : human(report, locale));
      process.exitCode = reasons.length ? 1 : 0;
    });
  }
}
