import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CorpusFile, QueryResult } from './contracts.js';

export type RgExecution = { code: number | null; stdout: Buffer; stderr: string; failure: 'missing-rg' | 'execution-error' | null; truncated: boolean };
export type RgRunner = (cwd: string, args: string[], maxBytes: number, timeoutMs: number, signal?: AbortSignal) => Promise<RgExecution>;
export const runRg: RgRunner = (cwd, args, maxBytes, timeoutMs, signal) => new Promise(resolve => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('RIPGREP_')));
  const child = spawn('rg', args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
  const chunks: Buffer[] = []; let bytes = 0; let stderr = Buffer.alloc(0); let failure: RgExecution['failure'] = null; let truncated = false;
  const timer = setTimeout(() => { failure = 'execution-error'; child.kill(); }, timeoutMs);
  child.stdout!.on('data', (chunk: Buffer) => { const kept = chunk.subarray(0, Math.max(0, maxBytes - bytes)); if (kept.length) chunks.push(kept); bytes += chunk.length; if (bytes > maxBytes) { truncated = true; child.kill(); } });
  child.stderr!.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(0, 4096); });
  child.once('error', error => { failure = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-rg' : 'execution-error'; });
  child.once('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks), stderr: stderr.toString('utf8'), failure, truncated }); });
});

// Only generated, regular files live in this directory. rg never traverses the
// actual workspace, symlinks, ignores, or repository-controlled configuration.
export class CandidateSearch {
  private constructor(readonly directory: string, private files: Map<string, CorpusFile>, readonly runner: RgRunner, readonly maxBytes: number, readonly timeoutMs: number, readonly signal?: AbortSignal) {}
  static async create(files: CorpusFile[], maxBytes: number, timeoutMs: number, signal?: AbortSignal, runner: RgRunner = runRg) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'difflearn-rg-')); const names = new Map<string, CorpusFile>();
    try {
      for (const [index, file] of files.entries()) { const name = `${String(index).padStart(9, '0')}.txt`; names.set(name, file); await writeFile(path.join(directory, name), file.bytes, { flag: 'wx' }); }
      return new CandidateSearch(directory, names, runner, maxBytes, timeoutMs, signal);
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async search(query: string, limit: number, remainingMs = this.timeoutMs): Promise<QueryResult> {
    const args = ['--json', '--fixed-strings', '--case-sensitive', '--no-config', '--no-ignore', '--hidden', '--no-follow', '--no-mmap', '--no-pre', '--no-search-zip', '--encoding', 'none', '--color', 'never', '--threads', '1', '--sort', 'path', '--max-count', String(limit + 1), '-e', query, '--', '.'];
    const result: QueryResult = { outcome: 'no-matches', matches: [], reasons: [], observedMatches: 0, omittedMatches: 0, arguments: args };
    if (!this.files.size) return result;
    const execution = await this.runner(this.directory, args, this.maxBytes, Math.max(1, Math.min(this.timeoutMs, remainingMs)), this.signal);
    if (execution.failure || !execution.truncated && execution.code !== 0 && execution.code !== 1) { result.outcome = execution.failure ?? 'execution-error'; result.reasons = [result.outcome === 'missing-rg' ? 'RG_MISSING' : 'RG_EXECUTION_ERROR']; result.omittedMatches = null; return result; }
    let countBound = false;
    try {
      const records = execution.stdout.toString('utf8').split('\n'); if (execution.truncated) records.pop();
      for (const record of records) {
        if (!record) continue;
        const item = JSON.parse(record) as { type: string; data: { path?: { text?: string }; line_number?: number; absolute_offset?: number; submatches?: { start: number; end: number }[]; stats?: { matched_lines?: number } } };
        if (item.type === 'end' && (item.data.stats?.matched_lines ?? 0) >= limit + 1) countBound = true;
        if (item.type !== 'match') continue;
        const filename = item.data.path?.text?.replace(/^\.([/\\])/u, ''); const file = filename ? this.files.get(filename) : undefined;
        if (!file || !Number.isSafeInteger(item.data.line_number) || item.data.line_number! < 1 || !Number.isSafeInteger(item.data.absolute_offset) || item.data.absolute_offset! < 0 || !Array.isArray(item.data.submatches)) throw new Error('Invalid rg match metadata');
        for (const match of item.data.submatches) {
          const start = item.data.absolute_offset! + match.start, end = item.data.absolute_offset! + match.end;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > file.bytes.length || match.start < 0 || match.end < match.start || !file.bytes.subarray(start, end).equals(Buffer.from(query))) throw new Error('rg range does not match captured bytes');
          const prefix = file.bytes.subarray(0, item.data.absolute_offset!); if ((prefix.length && prefix.at(-1) !== 10) || prefix.reduce((lines, byte) => lines + (byte === 10 ? 1 : 0), 1) !== item.data.line_number) throw new Error('rg line coordinates disagree with captured content');
          result.observedMatches++;
          if (result.matches.length < limit) result.matches.push({ file, startByte: start, endByte: end, line: item.data.line_number!, startColumn: match.start, endColumn: match.end });
        }
      }
    } catch { result.outcome = 'execution-error'; result.reasons = ['RG_OUTPUT_INVALID']; result.matches = []; result.omittedMatches = null; return result; }
    const truncated = execution.truncated || countBound || result.observedMatches > limit;
    result.outcome = truncated ? 'truncated' : result.matches.length ? 'matches' : 'no-matches'; result.omittedMatches = truncated ? null : 0;
    if (truncated) result.reasons = ['REFERENCE_RESULT_LIMIT'];
    return result;
  }
  async dispose() { if (path.dirname(this.directory) !== os.tmpdir() || !path.basename(this.directory).startsWith('difflearn-rg-')) throw new Error('Unsafe temporary search path'); await rm(this.directory, { recursive: true, force: true }); }
}
