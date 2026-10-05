import { spawn } from 'node:child_process';
import { mkdtemp, readFile, copyFile, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ScanError } from '../config/load.js';
import type { Limits } from '../config/schema.js';

export type OutputPolicy = { limit: number; retainPrefix: boolean };
export type GitResult = { code: number; stdout: Buffer; stderr: string; truncated?: boolean; observedBytes?: number };
export type GitRunner = (cwd: string, args: string[], limits: Limits, signal?: AbortSignal, input?: Buffer, outputPolicy?: OutputPolicy) => Promise<GitResult>;
type IndexContext = { indexFile: string; directory?: string; commonDirectory?: string; worktree?: string };

const runGitProcess = (cwd: string, args: string[], limits: Limits, signal?: AbortSignal, input?: Buffer, outputPolicy?: OutputPolicy, index?: IndexContext): Promise<GitResult> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new ScanError('INTERRUPTED', 'Scan interrupted', 1)); return; }
  if (input && input.length > limits.maxMetadataBytes) { reject(new ScanError('GIT_INPUT_LIMIT', 'Git metadata input exceeded its byte limit', 1)); return; }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_PAGER: 'cat', LC_ALL: 'C', LANG: 'C' });
  // These overrides are collector-owned; inherited Git redirects stay cleared.
  if (index) {
    env['GIT_INDEX_FILE'] = index.indexFile;
    if (index.directory) Object.assign(env, { GIT_DIR: index.directory, GIT_COMMON_DIR: index.commonDirectory!, GIT_WORK_TREE: index.worktree! });
  }
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

export const runGit: GitRunner = async (cwd, args, limits, signal, input, outputPolicy) => {
  // Even ls-files/status/check-attr freshen a split index's shared file on read.
  // Isolate every index reader, not just diff's optional refresh writes.
  const command = args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-c');
  const diff = command === 'diff';
  if (!diff && !['ls-files', 'status', 'check-attr'].includes(command ?? '') && !(command === 'rev-parse' && args.includes('--shared-index-path'))) return runGitProcess(cwd, args, limits, signal, input, outputPolicy);
  const started = performance.now();
  const remaining = () => {
    const gitTimeoutMs = limits.gitTimeoutMs - (performance.now() - started);
    if (gitTimeoutMs <= 0) throw new ScanError('GIT_TIMEOUT', 'Git process exceeded its time limit', 1);
    return { ...limits, gitTimeoutMs };
  };
  const located = await runGitProcess(cwd, ['rev-parse', '--absolute-git-dir'], remaining(), signal);
  if (located.code !== 0) return located;
  const gitDirectory = located.stdout.toString('utf8').trimEnd();
  let commonDirectory = gitDirectory;
  try { commonDirectory = path.resolve(gitDirectory, (await readFile(path.join(gitDirectory, 'commondir'), 'utf8')).trimEnd()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'difflearn-index-'));
  try {
    let bytes = Buffer.alloc(0); let copiedBytes = 0;
    try {
      const filename = path.join(directory, 'index');
      await copyFile(path.join(gitDirectory, 'index'), filename);
      const info = await stat(filename);
      if (info.size > limits.maxSnapshotBytes) throw new ScanError('SNAPSHOT_BYTE_LIMIT', 'Index copy exceeds snapshot bounds', 1);
      bytes = await readFile(filename); copiedBytes = bytes.length;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // A shared index's hash is embedded in the split-index link extension.
    // Copy matching names without interpreting or rebuilding index entries/flags.
    let shared = false;
    for (const name of await readdir(gitDirectory)) if (/^sharedindex\.(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(name) && bytes.includes(Buffer.from(name.slice(12), 'hex'))) {
      shared = true;
      const filename = path.join(directory, name);
      await copyFile(path.join(gitDirectory, name), filename); copiedBytes += (await stat(filename)).size;
      if (copiedBytes > limits.maxSnapshotBytes) throw new ScanError('SNAPSHOT_BYTE_LIMIT', 'Shared index copies exceed snapshot bounds', 1);
    }
    const indexFile = path.join(directory, 'index');
    if (shared) {
      await copyFile(path.join(gitDirectory, 'HEAD'), path.join(directory, 'HEAD'));
      const isolated = { indexFile, directory, commonDirectory, worktree: cwd };
      if (command === 'rev-parse' && args.includes('--shared-index-path')) return await runGitProcess(cwd, args, remaining(), signal, input, outputPolicy, isolated);
      // Git merges split entries and retains semantic flags in a full private
      // index. Only this conversion uses the temporary Git directory; actual
      // reads/diffs keep original refs, attributes and conditional configuration.
      const converted = await runGitProcess(cwd, ['-c', 'core.splitIndex=false', 'update-index', '--no-split-index'], remaining(), signal, undefined, undefined, isolated);
      if (converted.code !== 0) return converted;
    }
    return await runGitProcess(cwd, [...diff ? ['-c', 'diff.autoRefreshIndex=true', '-c', 'core.splitIndex=false'] : [], ...args], remaining(), signal, input, outputPolicy, { indexFile });
  } finally {
    const relative = path.relative(os.tmpdir(), directory);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ScanError('PATH_ESCAPE', 'Disposable index escaped its temporary directory', 1);
    await rm(directory, { recursive: true, force: true });
  }
};
