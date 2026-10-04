import { spawn } from 'node:child_process';
import { ScanError } from '../config/load.js';
import type { Limits } from '../config/schema.js';

export type OutputPolicy = { limit: number; retainPrefix: boolean };
export type GitResult = { code: number; stdout: Buffer; stderr: string; truncated?: boolean; observedBytes?: number };
export type GitRunner = (cwd: string, args: string[], limits: Limits, signal?: AbortSignal, input?: Buffer, outputPolicy?: OutputPolicy) => Promise<GitResult>;

export const runGit: GitRunner = (cwd, args, limits, signal, input, outputPolicy) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new ScanError('INTERRUPTED', 'Scan interrupted', 1)); return; }
  if (input && input.length > limits.maxMetadataBytes) { reject(new ScanError('GIT_INPUT_LIMIT', 'Git metadata input exceeded its byte limit', 1)); return; }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_PAGER: 'cat', LC_ALL: 'C', LANG: 'C' });
  const child = spawn('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'protocol.allow=never', ...args], { cwd, env, shell: false, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
  child.stdin?.on('error', () => { /* a process failure is reported at close */ });
  child.stdin?.end(input);
  const output: Buffer[] = [];
  let size = 0; let retained = 0; let truncated = false; let stderr = Buffer.alloc(0); let failure: ScanError | undefined;
  const outputLimit = outputPolicy?.limit ?? limits.maxMetadataBytes;
  const timeout = setTimeout(() => { failure = new ScanError('GIT_TIMEOUT', 'Git process exceeded its time limit', 1); child.kill(); }, limits.gitTimeoutMs);
  child.stdout!.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (outputPolicy?.retainPrefix) {
      const prefix = chunk.subarray(0, Math.max(0, outputLimit - retained));
      if (prefix.length) { output.push(prefix); retained += prefix.length; }
      if (size > outputLimit && !truncated) { truncated = true; child.kill(); }
    } else if (size > outputLimit) { failure = new ScanError('GIT_OUTPUT_LIMIT', 'Git metadata exceeded its byte limit', 1); child.kill(); }
    else output.push(chunk);
  });
  child.stderr!.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(0, 16_384); });
  child.once('error', error => { clearTimeout(timeout); reject(new ScanError('GIT_EXECUTION_FAILED', `Cannot execute Git: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`, 1)); });
  child.once('close', code => {
    clearTimeout(timeout);
    if (failure) reject(failure);
    else resolve({ code: code ?? 1, stdout: Buffer.concat(output), stderr: stderr.toString('utf8'), ...(outputPolicy ? { truncated, observedBytes: size } : {}) });
  });
});
