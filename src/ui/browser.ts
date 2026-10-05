import { spawn } from 'node:child_process';

/** Only server-generated loopback URLs reach the platform opener; no shell or repository command. */
export async function openBrowser(url: string, signal?: AbortSignal): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('Browser target must be a local app URL');
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); finish(new Error('Browser opener did not finish')); }, 5000);
    const aborted = () => { child.kill(); finish(signal?.reason ?? new Error('Interrupted')); };
    const finish = (error?: Error) => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
    child.once('error', finish); child.once('exit', code => finish(code === 0 ? undefined : new Error(`Browser opener exited with ${code}`)));
    signal?.addEventListener('abort', aborted, { once: true }); if (signal?.aborted) aborted();
  });
}
