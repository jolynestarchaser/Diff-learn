import { lstat, stat, realpath, opendir } from 'node:fs/promises';
import path from 'node:path';
import { ScanError } from '../config/load.js';
import type { Config, Limits } from '../config/schema.js';
import { compareText, isWithin, relativePath, repositoryId } from './identity.js';
import { runGit, type GitRunner } from './runner.js';

export const builtInExcludes = ['.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.test-dist', '.difflearn', '.aws', '.ssh', '.codex', '.agents'];
export type Diagnostic = { code: string; severity: 'warning' | 'error'; stage: 'discovery'; path: string | null; message: string };
export type Repository = {
  repositoryId: string; key: string; path: string; kind: 'worktree' | 'unsupported-bare' | 'failed';
  topLevel: string | null; gitDirectory: string | null; commonDirectory: string | null;
  linkedWorktree: boolean | null; objectFormat: string | null;
  baseConfiguration: { input: string | null; source: 'repository-config' | 'workspace-config' | null; state: 'not-resolved' };
  submodules: { path: string; childContent: 'not-collected' }[];
};
export type DirectoryEntry = { name: string; type: 'directory' | 'symlink' | 'other' };
export type DiscoveryIO = { readDirectory: (directory: string, byteLimit: number) => Promise<DirectoryEntry[]>; git: GitRunner };

async function readDirectory(directory: string, byteLimit: number): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = []; let bytes = 0;
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const raw = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
    bytes += raw.length + 64;
    if (bytes > byteLimit) throw new ScanError('DIRECTORY_OUTPUT_LIMIT', 'Directory listing exceeded its byte limit', 1);
    const name = raw.toString('utf8');
    if (name.includes('\uFFFD')) throw new ScanError('UNSUPPORTED_PATH_ENCODING', 'Directory contains a potentially non-UTF-8 filename; subtree not traversed', 1);
    entries.push({ name, type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'other' });
  }
  return entries.sort((a, b) => compareText(a.name, b.name));
}

export async function discover(root: string, config: Config, limits: Limits, selections: string[] = [], io: DiscoveryIO = { readDirectory, git: runGit }, signal?: AbortSignal, rootOnly = false) {
  const repositories: Repository[] = []; const diagnostics: Diagnostic[] = [];
  const skipped: { path: string; reason: string }[] = []; const incompleteSubtrees: string[] = [];
  const excludes = [...new Set([...builtInExcludes, ...config.excludeDirectories ?? []])].sort(compareText);
  const excludePaths = [...config.excludePaths ?? []].sort(compareText);
  const visited = new Set<string>(); const repoIdentities = new Set<string>();
  const submoduleBoundaries = new Set<string>();
  let visitedDirectories = 0; let candidateCount = 0; let repositoryCount = 0;
  let readableDirectories = 0;
  let detailBytes = 0; let omittedDetails = 0; let incompleteCount = 0; let skippedCount = 0;
  const reasonCodes = new Set<string>();
  const queue = [{ directory: root, depth: 0 }];
  let queueCursor = 0;
  const keepDetail = (value: unknown): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (detailBytes + bytes > Math.min(limits.maxMetadataBytes, limits.maxBundleBytes / 4)) { omittedDetails++; return false; }
    detailBytes += bytes; return true;
  };
  const diagnostic = (code: string, location: string | null, message: string) => {
    reasonCodes.add(code);
    const item: Diagnostic = { code, severity: 'warning', stage: 'discovery', path: location, message };
    if (keepDetail(item)) diagnostics.push(item);
  };
  const skip = (location: string, reason: string) => { skippedCount++; const item = { path: location, reason }; if (keepDetail(item)) skipped.push(item); };
  const markIncomplete = (location: string, code: string, message: string) => { incompleteCount++; if (keepDetail(location)) incompleteSubtrees.push(location); diagnostic(code, location, message); };
  const describeError = (error: unknown): string => error instanceof ScanError ? error.message : `Filesystem operation failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`;
  const fsIdentity = async (directory: string): Promise<string> => {
    const info = await stat(directory, { bigint: true });
    return info.ino !== 0n ? `${info.dev}:${info.ino}` : await realpath(directory);
  };

  async function inspect(directory: string, depth: number) {
    const location = relativePath(root, directory);
    try {
      if (directory !== root && (await lstat(directory)).isSymbolicLink()) { skip(location, 'symlink'); return []; }
      const actual = await realpath(directory);
      if (!isWithin(root, actual)) { markIncomplete(location, 'PATH_ESCAPE', 'Directory escaped the canonical workspace boundary'); return []; }
      const identity = await fsIdentity(actual);
      if (visited.has(identity)) { skip(location, 'duplicate-directory'); return []; }
      visited.add(identity);
      const entries = await io.readDirectory(actual, limits.maxMetadataBytes);
      readableDirectories++;
      const gitMarker = entries.find(entry => entry.name === '.git');
      const bareCandidate = entries.some(entry => entry.name === 'HEAD') && entries.some(entry => entry.name === 'objects') && entries.some(entry => entry.name === 'refs');
      let boundariesKnown = true;
      if (gitMarker || bareCandidate) {
        candidateCount++;
        const override = config.repositories?.find(repo => repo.path === location);
        const key = override?.key ?? location;
        const repo: Repository = { repositoryId: repositoryId(key), key, path: location, kind: 'failed', topLevel: null, gitDirectory: null, commonDirectory: null, linkedWorktree: null, objectFormat: null, baseConfiguration: { input: override?.base ?? config.base ?? null, source: override?.base !== undefined ? 'repository-config' : config.base !== undefined ? 'workspace-config' : null, state: 'not-resolved' }, submodules: [] };
        try {
          if (gitMarker?.type === 'symlink') throw new ScanError('INVALID_GIT_MARKER', 'Symlink .git markers are not followed', 1);
          const deadline = performance.now() + limits.repoTimeoutMs;
          const git = async (args: string[]) => {
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw new ScanError('GIT_TIMEOUT', 'Repository verification exceeded its time limit', 1);
            const result = await io.git(actual, args, { ...limits, gitTimeoutMs: Math.min(limits.gitTimeoutMs, remaining) }, signal);
            if (result.code !== 0) throw new ScanError('REPOSITORY_INVALID', `Git verification failed (exit ${result.code}): ${result.stderr.slice(0, 2048)}`, 1);
            return result.stdout;
          };
          const decode = (bytes: Buffer): string => {
            const result = bytes.toString('utf8');
            if (!Buffer.from(result).equals(bytes)) throw new ScanError('UNSUPPORTED_PATH_ENCODING', 'Git returned non-UTF-8 metadata', 1);
            return result.replace(/\r?\n$/u, '');
          };
          const bare = decode(await git(['rev-parse', '--is-bare-repository'])) === 'true';
          if (bare && gitMarker) throw new ScanError('REPOSITORY_INVALID', 'A .git marker points to a bare repository', 1);
          repo.gitDirectory = await realpath(decode(await git(['rev-parse', '--absolute-git-dir'])));
          repo.commonDirectory = await realpath(decode(await git(['rev-parse', '--path-format=absolute', '--git-common-dir'])));
          repo.objectFormat = decode(await git(['rev-parse', '--show-object-format']));
          if (bare) {
            repo.kind = 'unsupported-bare';
            diagnostic('UNSUPPORTED_BARE', location, 'Bare repository has no working tree');
          } else {
            if (decode(await git(['rev-parse', '--is-inside-work-tree'])) !== 'true') throw new ScanError('REPOSITORY_INVALID', 'Candidate is not inside a working tree', 1);
            repo.topLevel = await realpath(decode(await git(['rev-parse', '--show-toplevel'])));
            if (await fsIdentity(repo.topLevel) !== identity) throw new ScanError('REPOSITORY_INVALID', 'Git toplevel does not match the candidate directory', 1);
            repo.linkedWorktree = await fsIdentity(repo.gitDirectory) !== await fsIdentity(repo.commonDirectory);
            const canonicalIdentity = `${identity}|${await fsIdentity(repo.gitDirectory)}`;
            if (repoIdentities.has(canonicalIdentity)) { skip(location, 'duplicate-repository'); return []; }
            repoIdentities.add(canonicalIdentity); repo.kind = 'worktree';
            try {
              const index = await git(['ls-files', '--stage', '-z']);
              const indexText = index.toString('utf8');
              if (!Buffer.from(indexText).equals(index)) throw new ScanError('UNSUPPORTED_PATH_ENCODING', 'Index contains non-UTF-8 filenames', 1);
              const indexPaths = new Set<string>();
              for (const record of indexText.split('\0')) {
                if (!record) continue;
                const match = /^([0-9]{6}) [a-f0-9]+ [0-3]\t([\s\S]+)$/u.exec(record);
                if (!match) throw new ScanError('INDEX_METADATA_INVALID', 'Cannot parse submodule boundary metadata', 1);
                indexPaths.add(match[2]!);
                if (indexPaths.size > limits.maxFiles) throw new ScanError('INDEX_FILE_LIMIT', 'Index path count exceeds maxFiles; child boundaries unavailable', 1);
                if (match[1] === '160000') {
                  const modulePath = match[2]!;
                  const absolute = path.resolve(actual, ...modulePath.split('/'));
                  if (!isWithin(root, absolute)) throw new ScanError('PATH_ESCAPE', 'Submodule path escapes root', 1);
                  submoduleBoundaries.add(absolute);
                  if (!repo.submodules.some(module => module.path === modulePath)) repo.submodules.push({ path: modulePath, childContent: 'not-collected' });
                }
              }
              repo.submodules.sort((a, b) => compareText(a.path, b.path));
            } catch (error) { boundariesKnown = false; markIncomplete(location, 'SUBMODULE_BOUNDARIES_UNAVAILABLE', describeError(error)); }
          }
        } catch (error) { repo.kind = 'failed'; markIncomplete(location, error instanceof ScanError ? error.code : 'REPOSITORY_INVALID', describeError(error)); }
        repositories.push(repo); repositoryCount++;
        if (repo.kind === 'unsupported-bare') return [];
      } else if (depth === 0) {
        const result = await io.git(actual, ['rev-parse', '--show-toplevel'], limits, signal);
        if (result.code === 0) markIncomplete('.', 'ROOT_INSIDE_REPOSITORY', 'Root is a repository subdirectory; choose its toplevel to include that repository');
      }
      if (rootOnly) return [];
      if (!boundariesKnown) return [];
      return entries.filter(entry => entry.type === 'directory' || entry.type === 'symlink').flatMap(entry => {
        const child = path.join(actual, entry.name); const childPath = relativePath(root, child);
        if (excludes.includes(entry.name) || excludePaths.some(exclude => childPath === exclude || childPath.startsWith(`${exclude}/`))) { skip(childPath, 'excluded'); return []; }
        if (submoduleBoundaries.has(child)) { skip(childPath, 'submodule'); return []; }
        if (entry.type === 'symlink') { skip(childPath, 'symlink'); return []; }
        if (depth >= limits.maxDepth) { markIncomplete(childPath, 'DEPTH_LIMIT', 'Subtree exceeds maxDepth'); return []; }
        return [{ directory: child, depth: depth + 1 }];
      });
    } catch (error) { markIncomplete(location, error instanceof ScanError ? error.code : 'TRAVERSAL_FAILED', describeError(error)); return []; }
  }

  while (queueCursor < queue.length) {
    if (signal?.aborted) throw new ScanError('INTERRUPTED', 'Scan interrupted', 1);
    // Sequential traversal keeps limits and parent submodule boundaries deterministic.
    const next = queue[queueCursor++]!;
    if (visitedDirectories >= limits.maxDirectories || repositoryCount >= limits.maxRepositories) {
      for (const pending of [next, ...queue.slice(queueCursor)]) markIncomplete(relativePath(root, pending.directory), visitedDirectories >= limits.maxDirectories ? 'DIRECTORY_LIMIT' : 'REPOSITORY_LIMIT', 'Discovery stopped at its configured limit');
      break;
    }
    visitedDirectories++;
    const children = await inspect(next.directory, next.depth);
    const available = Math.max(0, limits.maxDirectories - queue.length);
    if (children.length > available) markIncomplete(relativePath(root, next.directory), 'DIRECTORY_LIMIT', `${children.length - available} child subtrees exceed the directory scheduling budget`);
    for (const child of children.slice(0, available)) queue.push(child);
  }
  for (const override of config.repositories ?? []) {
    if (!repositories.some(repo => repo.path === override.path)) diagnostic('CONFIGURED_REPOSITORY_NOT_FOUND', override.path, 'Configured repository was missing, excluded, or not verified');
  }
  const keys = new Set<string>();
  for (const repo of repositories) {
    if (keys.has(repo.key)) throw new ScanError('REPOSITORY_KEY_COLLISION', `Logical key ${JSON.stringify(repo.key)} collides with a discovered repository`);
    keys.add(repo.key);
  }
  const unknown = selections.filter(selection => !repositories.some(repo => repo.path === selection));
  if (unknown.length) throw new ScanError('SELECTION_NOT_FOUND', `Repository selection not found: ${JSON.stringify(unknown)}`, incompleteCount ? 1 : 2);
  const selected = (selections.length ? repositories.filter(repo => selections.includes(repo.path)) : repositories).sort((a, b) => compareText(a.key, b.key));
  diagnostics.sort((a, b) => compareText(a.path ?? '', b.path ?? '') || compareText(a.code, b.code));
  skipped.sort((a, b) => compareText(a.path, b.path));
  if (omittedDetails) { reasonCodes.add('DETAIL_LIMIT'); diagnostics.push({ code: 'DETAIL_LIMIT', severity: 'warning', stage: 'discovery', path: null, message: `${omittedDetails} discovery detail records omitted at the metadata budget` }); }
  const incomplete = incompleteCount > 0 || omittedDetails > 0 || reasonCodes.has('CONFIGURED_REPOSITORY_NOT_FOUND') || selected.some(repo => repo.kind !== 'worktree');
  return { repositories: selected, diagnostics, discovery: { visitedDirectories, readableDirectories, candidateCount, discoveredCount: repositories.length, selectedCount: selected.length, remainingCount: incompleteCount ? null : 0, subprocessConcurrency: 1, excludeDirectories: excludes, excludePaths, submodulePolicy: 'parent-only', symlinkPolicy: 'do-not-follow', skippedCount, omittedDetails, skipped, incompleteSubtrees: [...new Set(incompleteSubtrees)].sort(compareText) }, completeness: { state: incomplete ? (selected.some(repo => repo.kind === 'worktree') || readableDirectories > 0 ? 'partial' : 'failed') : 'complete', reasons: [...reasonCodes].sort(compareText), omittedCount: incompleteCount ? null : (config.repositories ?? []).filter(repo => !repositories.some(found => found.path === repo.path)).length } };
}

export async function canonicalRoot(input: string): Promise<string> {
  try {
    const actual = await realpath(path.resolve(input));
    if (!(await lstat(actual)).isDirectory()) throw new Error('not a directory');
    return actual;
  } catch { throw new ScanError('ROOT_UNAVAILABLE', `Cannot access root directory ${JSON.stringify(path.resolve(input))}`, 1); }
}
