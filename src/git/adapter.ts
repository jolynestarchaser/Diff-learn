import { ScanError } from '../config/load.js';
import { opendir, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { Limits } from '../config/schema.js';
import type { Repository } from './discovery.js';
import { runGit, type GitRunner, type GitResult, type OutputPolicy } from './runner.js';
import { text, nulRecords, parseRaw, joinNumstat } from './metadata.js';

export type Scope = 'branch' | 'staged' | 'unstaged' | 'all';
export type Head = { oid: string | null; branch: string | null; state: 'attached' | 'detached' | 'unborn' };
export type Base = { input: string | null; resolutionSource: string | null; oid: string | null; reason: string | null; remoteFreshness: 'not-verified' };
export type Revisions = { head: Head; base: Base; mergeBase: { oid: string | null; candidates: string[]; reason: string | null; shallow: boolean } };
export const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--diff-algorithm=myers', '--no-indent-heuristic', '--find-renames=50%', '-l1000', '-O/dev/null', '--submodule=short', '--ignore-submodules=none', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--no-patch', '--full-index', '--abbrev=64', '--ita-visible-in-index'];
export const patchOptions = [...diffOptions.filter(option => option !== '--no-patch'), '--inter-hunk-context=0', '--patch'];
function comparisonInputs(scope: Scope, revisions: Revisions) {
  const { head, mergeBase } = revisions;
  return { args: scope === 'branch' ? [mergeBase.oid!, head.oid!] : scope === 'staged' ? ['--cached', ...head.oid ? [head.oid] : []] : scope === 'all' ? [mergeBase.oid!] : [], prefix: (scope === 'branch' || scope === 'staged') && head.oid ? [`--attr-source=${head.oid}`] : [] };
}
export class GitAdapter {
  overrides: string[] = [];
  warnings = new Set<string>();
  constructor(readonly repository: Repository, readonly limits: Limits, readonly deadline: number, readonly signal?: AbortSignal, readonly runner: GitRunner = runGit) {}
  async run(args: string[], input?: Buffer, outputPolicy?: OutputPolicy): Promise<GitResult> {
    const remaining = this.deadline - performance.now();
    if (remaining <= 0) throw new ScanError('REPOSITORY_TIMEOUT', 'Repository collection exceeded its total time budget', 1);
    const result = await this.runner(this.repository.topLevel!, [...this.overrides, ...args], { ...this.limits, gitTimeoutMs: Math.min(remaining, this.limits.gitTimeoutMs) }, this.signal, input, outputPolicy);
    if (result.code === 0 && result.stderr.trim()) this.warnings.add(result.stderr.slice(0, 2048));
    return result;
  }
  async required(args: string[], input?: Buffer): Promise<Buffer> {
    const result = await this.run(args, input);
    if (result.code !== 0) throw new ScanError('GIT_COMMAND_FAILED', `Git ${args[0]} failed (exit ${result.code}): ${result.stderr.slice(0, 2048)}`, 1);
    return result.stdout;
  }
  async configuration(): Promise<{ bytes: Buffer; values: Map<string, string[]>; activeDrivers: string[] }> {
    this.overrides = [];
    const bytes = await this.required(['config', '--null', '--list']); const values = new Map<string, string[]>();
    for (const record of nulRecords(bytes)) {
      const separator = record.indexOf(10); const key = text(separator < 0 ? record : record.subarray(0, separator)); const value = separator < 0 ? '' : text(record.subarray(separator + 1));
      values.set(key, [...values.get(key) ?? [], value]);
    }
    const drivers = new Set<string>(); const activeDrivers = new Set<string>();
    for (const [key, entries] of values) {
      const match = /^filter\.(.+)\.(clean|process|required)$/u.exec(key);
      if (match) { drivers.add(match[1]!); if (match[2] !== 'required' && entries.at(-1)) activeDrivers.add(match[1]!); }
    }
    this.overrides = [...drivers].sort().flatMap(driver => ['-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`]);
    // Pin ordering and presentation configuration as well as command flags.
    this.overrides.push('-c', 'diff.mnemonicPrefix=false', '-c', 'diff.noprefix=false', '-c', 'diff.suppressBlankEmpty=false', '-c', 'core.quotePath=true');
    return { bytes, values, activeDrivers: [...activeDrivers].sort() };
  }
  async revisions(cliBase?: string): Promise<Revisions> {
    const symbolic = await this.run(['symbolic-ref', '--quiet', 'HEAD']);
    const branchRef = symbolic.code === 0 ? text(symbolic.stdout).replace(/\n$/u, '') : null;
    if (symbolic.code !== 0 && symbolic.code !== 1) throw new ScanError('HEAD_UNRESOLVED', 'Cannot read HEAD symbolic state', 1);
    const resolvedHead = await this.run(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
    const oid = resolvedHead.code === 0 ? text(resolvedHead.stdout).trimEnd() : null;
    if (!oid) {
      const ref = branchRef ? await this.run(['show-ref', '--verify', '--quiet', branchRef]) : null;
      if (!branchRef || ref?.code !== 1) throw new ScanError('HEAD_UNRESOLVED', 'HEAD is missing, corrupt, or does not resolve to a commit', 1);
    }
    const head: Head = { oid, branch: branchRef?.replace(/^refs\/heads\//u, '') ?? null, state: !oid ? 'unborn' : branchRef ? 'attached' : 'detached' };
    let input = cliBase ?? this.repository.baseConfiguration.input;
    let source = cliBase !== undefined ? 'cli' : this.repository.baseConfiguration.source;
    let reason: string | null = null;
    if (input === null) {
      const origin = await this.run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
      if (origin.code === 0) { input = text(origin.stdout).replace(/\n$/u, ''); source = 'origin-head'; }
      else if (origin.code !== 1) reason = 'BASE_UNRESOLVED';
      else {
        const listed = await this.run(['for-each-ref', '--format=%(refname)%00%(symref)%00', 'refs/remotes/']);
        if (listed.code !== 0) throw new ScanError('BASE_ENUMERATION_FAILED', 'Cannot enumerate local remote default refs', 1);
        const records = text(listed.stdout).split('\n').filter(Boolean);
        const refs = new Set(records.flatMap(record => { const [ref, target] = record.split('\0'); return ref?.endsWith('/HEAD') && ref.split('/').length >= 4 && target ? [ref] : []; }));
        // for-each-ref omits dangling symbolic refs. Probe configured remotes and
        // bounded loose-ref names too, so a missing target cannot disappear.
        for (const remote of text(await this.required(['remote'])).split('\n').filter(Boolean)) refs.add(`refs/remotes/${remote}/HEAD`);
        const baseDirectory = path.join(this.repository.commonDirectory!, 'refs', 'remotes');
        const pending = [{ directory: baseDirectory, ref: 'refs/remotes' }]; let cursor = 0; let bytes = 0;
        while (cursor < pending.length) {
          if (performance.now() >= this.deadline || this.signal?.aborted) throw new ScanError('BASE_ENUMERATION_FAILED', 'Remote default enumeration exceeded its execution bounds', 1);
          const next = pending[cursor++]!;
          try {
            if ((await lstat(next.directory)).isSymbolicLink()) throw new ScanError('BASE_ENUMERATION_FAILED', 'Symlink remote ref storage cannot be enumerated safely', 1);
            const directory = await opendir(next.directory);
            for await (const entry of directory) {
              const name = text(Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name)); bytes += Buffer.byteLength(name) + 64;
              if (name.includes('\uFFFD')) throw new ScanError('UNSUPPORTED_PATH_ENCODING', 'Remote ref storage contains a potentially non-UTF-8 name', 1);
              if (bytes > this.limits.maxMetadataBytes || pending.length > this.limits.maxDirectories) throw new ScanError('BASE_ENUMERATION_FAILED', 'Remote ref names exceeded metadata bounds', 1);
              if (entry.isSymbolicLink()) throw new ScanError('BASE_ENUMERATION_FAILED', 'Symlink remote ref storage cannot be enumerated safely', 1);
              if (entry.isDirectory()) pending.push({ directory: path.join(next.directory, name), ref: `${next.ref}/${name}` });
              else if (name === 'HEAD' && next.ref !== 'refs/remotes') refs.add(`${next.ref}/HEAD`);
            }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const candidates: string[] = [];
        for (const ref of [...refs].sort()) {
          const symbolic = await this.run(['symbolic-ref', '--quiet', ref]);
          if (symbolic.code === 0) candidates.push(text(symbolic.stdout).replace(/\n$/u, ''));
          else if (symbolic.code !== 1) reason = 'BASE_UNRESOLVED';
        }
        const refFormat = text(await this.required(['rev-parse', '--show-ref-format'])).trimEnd();
        if (refFormat !== 'files' && candidates.length < 2) {
          reason = 'BASE_UNRESOLVED'; this.warnings.add('Automatic fallback cannot prove complete symbolic remote HEAD enumeration for this ref backend; supply --base');
        }
        if (listed.stderr.trim()) reason = 'BASE_UNRESOLVED';
        if (reason !== null) { /* unavailable enumeration cannot select a candidate */ }
        else if (candidates.length === 1) { input = candidates[0]!; source = 'remote-head'; }
        else reason = candidates.length > 1 ? 'BASE_AMBIGUOUS' : 'BASE_REQUIRED';
      }
    }
    let baseOid: string | null = null;
    if (input !== null) {
      const resolved = await this.run(['rev-parse', '--verify', '--end-of-options', `${input}^{commit}`]);
      if (resolved.code !== 0 || /ambiguous/iu.test(resolved.stderr)) reason = 'BASE_UNRESOLVED';
      else baseOid = text(resolved.stdout).trimEnd();
    }
    const base: Base = { input, resolutionSource: source, oid: baseOid, reason, remoteFreshness: 'not-verified' };
    const shallow = text(await this.required(['rev-parse', '--is-shallow-repository'])).trimEnd() === 'true';
    let candidates: string[] = []; let mergeReason: string | null = !oid ? 'UNBORN_HEAD' : reason;
    if (oid && baseOid) {
      const merge = await this.run(['merge-base', '--all', baseOid, oid]);
      if (merge.code === 0) candidates = text(merge.stdout).trimEnd().split('\n').filter(Boolean).sort();
      else if (merge.code !== 1) throw new ScanError('MERGE_BASE_FAILED', `Cannot compute merge-base: ${merge.stderr.slice(0, 2048)}`, 1);
      mergeReason = candidates.length === 0 ? 'NO_MERGE_BASE' : candidates.length > 1 ? 'MULTIPLE_MERGE_BASES' : null;
    }
    return { head, base, mergeBase: { oid: candidates.length === 1 ? candidates[0]! : null, candidates, reason: mergeReason, shallow } };
  }
  async comparison(scope: Scope, revisions: Revisions, omittedPaths = new Set<string>()) {
    const { args, prefix } = comparisonInputs(scope, revisions);
    const raw = async (policy: string[]) => parseRaw(await this.required([...prefix, 'diff', ...policy, '--raw', '-z', ...args, '--'])).filter(file => !omittedPaths.has(file.originalPathBytes) && !omittedPaths.has(file.destinationPathBytes));
    const preflight = await raw([...diffOptions, '--no-renames']);
    const limited = preflight.filter(file => file.status === 'A' || file.status === 'D').length > 1000;
    const policy = limited ? [...diffOptions, '--no-renames'] : diffOptions;
    const changes = limited ? preflight : await raw(policy);
    joinNumstat(changes, await this.required([...prefix, 'diff', ...policy, '--numstat', '-z', ...args, '--']), omittedPaths);
    changes.sort((a, b) => Buffer.compare(Buffer.from(a.destinationPathBytes, 'base64'), Buffer.from(b.destinationPathBytes, 'base64')));
    if (changes.length > this.limits.maxFiles) throw new ScanError('FILE_LIMIT', 'Comparison exceeds maxFiles', 1);
    return { changes, renameLimited: limited };
  }
  async patch(scope: Scope, revisions: Revisions, renameLimited: boolean) {
    const { args, prefix } = comparisonInputs(scope, revisions);
    const result = await this.run([...prefix, 'diff', ...patchOptions, ...renameLimited ? ['--no-renames'] : [], ...args, '--'], undefined, { limit: this.limits.maxPatchBytes, retainPrefix: true });
    if (result.code !== 0 && !result.truncated) throw new ScanError('PATCH_COMMAND_FAILED', `Git patch failed (exit ${result.code}): ${result.stderr.slice(0, 2048)}`, 1);
    return result;
  }
}
