import { findLocalRepository, collectLocalEvidence } from '../ui/local.js';
import { startUi } from '../ui/server.js';
import { openBrowser } from '../ui/browser.js';
import { captureOutgoing, collectOutgoingEvidence } from '../ui/outgoing.js';

export async function launchLocalApp(cwd: string, signal: AbortSignal, io = { open: openBrowser, write: (message: string) => process.stdout.write(message) }) {
  const repository = await findLocalRepository(cwd, signal);
  const session = await startUi(null, { signal, local: { ...repository, collect: collectionSignal => collectLocalEvidence(repository.root, collectionSignal), history: {
    capture: (collectionSignal, ref) => captureOutgoing(repository.root, collectionSignal, ref),
    collect: (review, selection, collectionSignal) => collectOutgoingEvidence(repository.root, review, selection, collectionSignal),
  } } });
  io.write(`Difflearn: ${repository.root}\nLocal changes (all, HEAD → working tree)\n${session.url}\nKeep this terminal open. Press Ctrl+C to stop.\n`);
  if (process.env.DIFFLEARN_NO_BROWSER !== '1') {
    try { await io.open(session.url, signal); }
    catch { if (!signal.aborted) io.write(`Could not open the browser. Open ${session.url} in your browser.\n`); }
  }
  await session.done;
  signal.throwIfAborted();
}
