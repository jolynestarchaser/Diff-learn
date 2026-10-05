import type { Command } from 'commander';
import { ScanError } from '../config/load.js';

export function registerUi(program: Command, signal: AbortSignal) {
  program.command('ui').description('Read-only local review UI for one validated exported evidence snapshot')
    .requiredOption('--evidence <file>', 'explicit JSON export (schema 1.0.0 / 1.1.0 / 1.2.0 / 1.3.0)')
    .option('--json', 'print one session-ready JSON line (no session secret)')
    .addHelpText('after', '\nBinds only 127.0.0.1 on an ephemeral port. Open the printed URL.\nCaptured export only; no Git collection, review writes or live refresh.\nCtrl+C closes the viewer. Sessions expire after 30 minutes.')
    .action(async (options: { evidence: string; json?: boolean }) => {
      for (const flag of ['--evidence', '--json']) if (process.argv.slice(3).filter(argument => argument.split('=')[0] === flag).length > 1) throw new ScanError('ARGUMENT_INVALID', `Duplicate scalar flag ${flag}`, 2);
      const { loadEvidenceBundle } = await import('../evidence/read.js');
      let bundle;
      try { bundle = await loadEvidenceBundle(options.evidence); }
      catch (error) { throw new ScanError('UI_EVIDENCE_INVALID', `Cannot open evidence: ${error instanceof Error ? error.message : 'invalid export'}. Re-export a supported evidence bundle with intact IDs.`, 2); }
      const { startUi } = await import('../ui/server.js'); const session = await startUi(bundle, { signal });
      process.stdout.write(options.json ? `${JSON.stringify({ url: session.url, schemaVersion: session.schemaVersion, readOnly: true, freshness: 'not-verified' })}\n` : `Difflearn read-only UI: ${session.url}\nCaptured export (${session.schemaVersion}); working-tree freshness not checked. Ctrl+C closes the viewer.\n`);
      await session.done; signal.throwIfAborted();
    });
}
