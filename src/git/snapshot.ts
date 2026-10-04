import { createHash } from 'node:crypto';
import { lstat, open, readlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ScanError } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { builtInExcludes } from './discovery.js';
import { GitAdapter } from './adapter.js';
import { gitPath, nulRecords, parseIndex, parseStatus, text, type GitPath, type WorkingStatus } from './metadata.js';
import { languageForPath } from '../language/contracts.js';

export function digest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export type SnapshotBudget = { workspaceBytes: number };
export type AttemptBudget = { bytes: number };
export type FileFingerprint = { type: string; mode: number | null; size: number | null; hash: string | null; guard: string | null };
export type FilesystemContent = { source: 'filesystem'; contentId: string | null; state: 'collected' | 'omitted'; reason: string | null; sha256: string | null; byteLength: number | null; text: string | null; bytes: string | null };
export type Untracked = GitPath & { type: string; size: number | null; contentPolicy: 'metadata-only' | 'opt-in-text'; content?: FilesystemContent };
export type CaptureOptions = { includeUntracked: boolean; retainContent: boolean; retainTracked?: boolean; retainAllTracked?: boolean };
export async function capture(adapter: GitAdapter, config: Config, budget: SnapshotBudget, cliBase?: string, attemptBudget: AttemptBudget = { bytes: 0 }, options?: CaptureOptions) {
  let attemptBytes = 0;
  let contentOutputBytes = 0;
  const configuration = await adapter.configuration();
  const revisions = await adapter.revisions(cliBase);
  const indexBytes = await adapter.required(['ls-files', '--stage', '-z']); const index = parseIndex(indexBytes);
  const flagsBytes = await adapter.required(['ls-files', '-v', '-z']);
  const flags = nulRecords(flagsBytes).map(record => ({ ...gitPath(record.subarray(2)), flag: record.subarray(0, 1).toString('ascii') }));
  const debug = await adapter.required(['ls-files', '--debug', '-z']); const intentToAdd: string[] = []; let debugCursor = 0;
  while (debugCursor < debug.length) {
    const end = debug.indexOf(0, debugCursor); if (end < 0) throw new ScanError('INDEX_FLAGS_INVALID', 'Cannot parse index flag metadata', 1);
    const encoded = debug.subarray(debugCursor, end).toString('base64');
    const flagStart = debug.indexOf(Buffer.from('\tflags: '), end + 1); const flagEnd = debug.indexOf(10, flagStart);
    if (flagStart < 0 || flagEnd < 0 || flagEnd - end > 1024) throw new ScanError('INDEX_FLAGS_INVALID', 'Unsupported Git index debug format', 1);
    const metadata = /^ {2}ctime: [^\n]*\n {2}mtime: [^\n]*\n {2}dev: [^\n]*\n {2}uid: [^\n]*\n {2}size: [^\n]*\tflags: ([a-f0-9]+)\n/u.exec(debug.subarray(end + 1, flagEnd + 1).toString('ascii'));
    if (!metadata) throw new ScanError('INDEX_FLAGS_INVALID', 'Unsupported Git index debug format', 1);
    if ((Number.parseInt(metadata[1]!, 16) & 0x20000000) !== 0) intentToAdd.push(encoded);
    debugCursor = end + 1 + Buffer.byteLength(metadata[0]);
  }
  const paths = [...new Set(index.map(entry => entry.pathBytes))].sort((a, b) => Buffer.compare(Buffer.from(a, 'base64'), Buffer.from(b, 'base64')));
  if (paths.length > adapter.limits.maxFiles) throw new ScanError('FILE_LIMIT', 'Snapshot index exceeds maxFiles', 1);
  const root = adapter.repository.topLevel!;
  const workingReasons = new Set<string>(); const immutableReasons = new Set<string>(); const restrictedPaths: { path: string | null; reason: string }[] = [];
  const checkDeadline = () => { if (adapter.signal?.aborted) throw new ScanError('INTERRUPTED', 'Collection interrupted', 1); if (performance.now() >= adapter.deadline) throw new ScanError('REPOSITORY_TIMEOUT', 'Snapshot exceeded the repository time budget', 1); };
  const retainedContents = new Map<string, Buffer>();
  const trackedContents = new Map<string, Buffer>(); let retainedTrackedBytes = 0;
  async function fingerprint(filename: string, content: boolean, untrackedContent = false, retainTracked = false): Promise<FileFingerprint> {
    checkDeadline();
    try {
      const info = await lstat(filename, { bigint: true });
      const type = info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'special';
      const guard = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}`;
      const basic: FileFingerprint = { type, mode: Number(info.mode), size: Number(info.size), hash: null, guard };
      if (!content || type === 'directory') return basic;
      if (type === 'symlink') {
        const target = await readlink(filename, { encoding: 'buffer' }); attemptBytes += target.length; attemptBudget.bytes += target.length; budget.workspaceBytes += target.length;
        if (attemptBudget.bytes > adapter.limits.maxSnapshotBytes || budget.workspaceBytes > adapter.limits.maxWorkspaceSnapshotBytes) throw new ScanError('SNAPSHOT_BYTE_LIMIT', 'Snapshot hashing budget exhausted', 1);
        return { ...basic, hash: createHash('sha256').update(target).digest('hex') };
      }
      if (type !== 'file') throw new ScanError('UNSUPPORTED_FILE_TYPE', 'Cannot hash a special filesystem object', 1);
      if (attemptBudget.bytes + Number(info.size) > adapter.limits.maxSnapshotBytes || budget.workspaceBytes + Number(info.size) > adapter.limits.maxWorkspaceSnapshotBytes) throw new ScanError('SNAPSHOT_BYTE_LIMIT', 'Snapshot hashing budget exhausted', 1);
      const handle = await open(filename, 'r');
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new ScanError('SNAPSHOT_CHANGED', 'File changed during capture', 1);
        const hash = createHash('sha256'); const buffer = Buffer.alloc(65_536); let read = 0; const chunks: Buffer[] = [];
        const retain = untrackedContent || retainTracked && Number(info.size) <= adapter.limits.maxFileBytes && retainedTrackedBytes + Number(info.size) <= adapter.limits.maxPatchBytes;
        while (true) {
          checkDeadline(); const result = await handle.read(buffer, 0, buffer.length, null); if (result.bytesRead === 0) break;
          read += result.bytesRead; attemptBytes += result.bytesRead; attemptBudget.bytes += result.bytesRead; budget.workspaceBytes += result.bytesRead;
          if (untrackedContent && read > adapter.limits.maxFileBytes) throw new ScanError('SNAPSHOT_CHANGED', 'Untracked file grew beyond its content bound during capture', 1);
          if (attemptBudget.bytes > adapter.limits.maxSnapshotBytes || budget.workspaceBytes > adapter.limits.maxWorkspaceSnapshotBytes) throw new ScanError('SNAPSHOT_BYTE_LIMIT', 'Snapshot hashing budget exhausted', 1);
          hash.update(buffer.subarray(0, result.bytesRead));
          if (retain && read <= adapter.limits.maxFileBytes) chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
        }
        const after = await handle.stat({ bigint: true });
        if (read !== Number(info.size) || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs || after.size !== info.size) throw new ScanError('SNAPSHOT_CHANGED', 'File changed while hashing', 1);
        if (retain && read <= adapter.limits.maxFileBytes) { retainedContents.set(filename, Buffer.concat(chunks)); if (retainTracked) retainedTrackedBytes += read; }
        return { ...basic, hash: hash.digest('hex') };
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return { type: 'missing', mode: null, size: null, hash: null, guard: null };
      throw error;
    }
  }
  async function safePath(relative: string): Promise<boolean> {
    if (relative.startsWith('/') || relative.split('/').some(part => part === '..' || part === '.' || !part)) throw new ScanError('PATH_ESCAPE', 'Git path violates the repository boundary', 1);
    if (process.platform === 'win32' && (relative.includes('\\') || /^[a-z]:/iu.test(relative))) throw new ScanError('PATH_ESCAPE', 'Git path is not a native repository-relative Windows path', 1);
    const components = relative.split('/');
    for (let count = 1; count < components.length; count++) {
      try { if ((await lstat(path.join(root, ...components.slice(0, count)))).isSymbolicLink()) return false; }
      catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return true; throw error; }
    }
    return true;
  }
  const working: { pathBytes: string; fingerprint: FileFingerprint }[] = [];
  const submoduleGuards: { pathBytes: string; configuration: string; index: string; head: string }[] = [];
  const attributePaths = new Set<string>(['.gitattributes', '.gitignore']);
  for (const encoded of paths) {
    const entry = index.find(item => item.pathBytes === encoded)!;
    if (entry.path === null) { workingReasons.add('UNSUPPORTED_PATH_ENCODING'); restrictedPaths.push({ path: null, reason: 'UNSUPPORTED_PATH_ENCODING' }); continue; }
    const components = entry.path.split('/');
    for (let count = 1; count < components.length; count++) { const prefix = components.slice(0, count).join('/'); attributePaths.add(`${prefix}/.gitattributes`); attributePaths.add(`${prefix}/.gitignore`); }
    if (!await safePath(entry.path)) { workingReasons.add('WORKTREE_SYMLINK_BOUNDARY'); restrictedPaths.push({ path: entry.path, reason: 'WORKTREE_SYMLINK_BOUNDARY' }); continue; }
    if (entry.mode !== '160000') {
      const filename = path.join(root, ...components); working.push({ pathBytes: encoded, fingerprint: await fingerprint(filename, true, false, options?.retainAllTracked === true || options?.retainTracked === true && languageForPath(entry.path) !== null) });
      const retained = retainedContents.get(filename); if (retained) { trackedContents.set(encoded, retained); retainedContents.delete(filename); }
    }
    else {
      const directory = path.join(root, ...components); const moduleInfo = await fingerprint(directory, false);
      if (moduleInfo.type === 'symlink') { workingReasons.add('WORKTREE_SYMLINK_BOUNDARY'); continue; }
      if (moduleInfo.type === 'directory') {
        const metadata = await fingerprint(path.join(directory, '.git'), false);
        if (metadata.type === 'symlink') { workingReasons.add('WORKTREE_SYMLINK_BOUNDARY'); continue; }
        if (metadata.type !== 'missing') {
          const childRun = async (args: string[]) => {
            checkDeadline(); const result = await adapter.runner(directory, args, { ...adapter.limits, gitTimeoutMs: Math.min(adapter.limits.gitTimeoutMs, adapter.deadline - performance.now()) }, adapter.signal);
            if (result.code !== 0) throw new ScanError('SUBMODULE_STATE_UNAVAILABLE', 'Cannot verify initialized submodule metadata', 1);
            if (result.stderr.trim()) adapter.warnings.add(result.stderr.slice(0, 2048));
            return result.stdout;
          };
          const childConfig = await childRun(['config', '--null', '--list']); const childIndex = await childRun(['ls-files', '--stage', '-z']); const childEntries = parseIndex(childIndex);
          if (childEntries.length > adapter.limits.maxFiles) throw new ScanError('FILE_LIMIT', 'Submodule boundary metadata exceeds maxFiles', 1);
          const childHead = await childRun(['rev-parse', '--verify', 'HEAD']);
          submoduleGuards.push({ pathBytes: encoded, configuration: digest(text(childConfig)), index: digest(childEntries), head: text(childHead).trimEnd() });
          const childValues = new Map<string, string>();
          for (const record of nulRecords(childConfig)) { const separator = record.indexOf(10); childValues.set(text(separator < 0 ? record : record.subarray(0, separator)), separator < 0 ? '' : text(record.subarray(separator + 1))); }
          const childDrivers = [...new Set([...childValues].flatMap(([key, value]) => { const match = /^filter\.(.+)\.(?:clean|process)$/u.exec(key); return match && value ? [match[1]!] : []; }))];
          for (const driver of childDrivers) adapter.overrides.push('-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`);
          let childSafe = true; const childAttributes = new Set<string>([`${entry.path}/.gitattributes`]);
          for (const childEntry of childEntries) {
            if (childEntry.path === null) { workingReasons.add('UNSUPPORTED_PATH_ENCODING'); childSafe = false; continue; }
            if (!await safePath(`${entry.path}/${childEntry.path}`)) { workingReasons.add('WORKTREE_SYMLINK_BOUNDARY'); childSafe = false; }
            const childComponents = childEntry.path.split('/');
            for (let count = 1; count < childComponents.length; count++) childAttributes.add(`${entry.path}/${childComponents.slice(0, count).join('/')}/.gitattributes`);
            if (childEntry.mode === '160000') { workingReasons.add('NESTED_SUBMODULE_STATE_UNSUPPORTED'); childSafe = false; }
          }
          for (const attribute of childAttributes) {
            if (!await safePath(attribute)) { childSafe = false; workingReasons.add('WORKTREE_SYMLINK_BOUNDARY'); continue; }
            if ((await fingerprint(path.join(root, ...attribute.split('/')), false)).type === 'symlink') { childSafe = false; workingReasons.add('ATTRIBUTE_SYMLINK'); }
          }
          if (childSafe && childDrivers.length) {
            const input = Buffer.concat(childEntries.map(item => Buffer.concat([Buffer.from(item.path!), Buffer.from([0])])));
            checkDeadline(); const result = await adapter.runner(directory, [...adapter.overrides, 'check-attr', '-z', '--stdin', 'filter'], { ...adapter.limits, gitTimeoutMs: Math.min(adapter.limits.gitTimeoutMs, adapter.deadline - performance.now()) }, adapter.signal, input);
            if (result.code !== 0) throw new ScanError('SUBMODULE_STATE_UNAVAILABLE', 'Cannot inspect submodule attributes', 1);
            const records = nulRecords(result.stdout); if (records.length !== childEntries.length * 3) throw new ScanError('METADATA_INVALID', 'Incomplete submodule attribute metadata', 1);
            for (let cursor = 0; cursor < records.length; cursor += 3) if (childDrivers.includes(text(records[cursor + 2]!))) workingReasons.add('SUBMODULE_ACTIVE_FILTER');
            // Attribute changes can affect whether a child's filters are active.
            submoduleGuards.push({ pathBytes: encoded, configuration: digest(result.stdout.toString('base64')), index: '', head: '' });
          }
        }
      }
    }
  }
  for (const flag of flags) if (flag.flag === 'S' || flag.flag === flag.flag.toLowerCase()) {
    const reason = flag.flag.toUpperCase() === 'S' ? 'SKIP_WORKTREE' : 'ASSUME_UNCHANGED'; workingReasons.add(reason); restrictedPaths.push({ path: flag.path, reason });
  }
  const sparse = configuration.values.get('core.sparsecheckout')?.at(-1) === 'true';
  if (sparse) workingReasons.add('SPARSE_CHECKOUT');
  const attributes: { key: string; fingerprint: FileFingerprint }[] = [];
  for (const relative of [...attributePaths].sort()) {
    if (!await safePath(relative)) { workingReasons.add('WORKTREE_SYMLINK_BOUNDARY'); continue; }
    const captured = await fingerprint(path.join(root, ...relative.split('/')), true);
    if (captured.type === 'symlink') workingReasons.add('ATTRIBUTE_SYMLINK');
    attributes.push({ key: relative, fingerprint: captured });
  }
  const externalFiles = [
    ['info-attributes', path.join(adapter.repository.commonDirectory!, 'info', 'attributes')],
    ['info-exclude', path.join(adapter.repository.commonDirectory!, 'info', 'exclude')],
    ['global-attributes-default', path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'), 'git', 'attributes')],
  ];
  for (const key of ['core.attributesfile', 'core.excludesfile']) {
    const configured = await adapter.run(['config', '--null', '--path', '--get', key]);
    if (configured.code === 0) { const records = nulRecords(configured.stdout); if (records.length !== 1) throw new ScanError('METADATA_INVALID', 'Invalid configured path metadata', 1); externalFiles.push([key, path.resolve(root, text(records[0]!))]); }
  }
  for (const [key, filename] of externalFiles) { const captured = await fingerprint(filename!, true); if (captured.type === 'symlink') { workingReasons.add('ATTRIBUTE_SYMLINK'); immutableReasons.add('ATTRIBUTE_SYMLINK'); } attributes.push({ key: key!, fingerprint: captured }); }
  let activeFilterPaths: string[] = [];
  if (!workingReasons.has('WORKTREE_SYMLINK_BOUNDARY') && !workingReasons.has('ATTRIBUTE_SYMLINK') && configuration.activeDrivers.length) {
    const input = Buffer.concat(index.filter(entry => entry.path !== null).map(entry => Buffer.concat([Buffer.from(entry.path!), Buffer.from([0])])));
    const records = nulRecords(await adapter.required(['check-attr', '-z', '--stdin', 'filter'], input));
    if (records.length !== index.filter(entry => entry.path !== null).length * 3) throw new ScanError('METADATA_INVALID', 'Incomplete attribute metadata', 1);
    for (let cursor = 0; cursor < records.length; cursor += 3) if (configuration.activeDrivers.includes(text(records[cursor + 2]!))) activeFilterPaths.push(text(records[cursor]!));
    activeFilterPaths = [...new Set(activeFilterPaths)].sort();
    if (activeFilterPaths.length) { workingReasons.add('ACTIVE_FILTER'); restrictedPaths.push(...activeFilterPaths.map(location => ({ path: location, reason: 'ACTIVE_FILTER' }))); }
  }
  const status: WorkingStatus = workingReasons.size ? { available: false, clean: null, entries: [], untracked: [], headers: {}, reasons: [...workingReasons].sort() }
    : parseStatus(await adapter.required(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=none']));
  const untracked: Untracked[] = []; const untrackedGuards: { pathBytes: string; fingerprint: FileFingerprint }[] = []; let excludedUntrackedCount = 0;
  const excludedDirs = [...builtInExcludes, ...config.excludeDirectories ?? []];
  for (const entry of status.untracked) {
    if (entry.path === null) {
      status.reasons.push('UNSUPPORTED_PATH_ENCODING');
      untracked.push({ ...entry, type: 'unsupported-path-encoding', size: null, contentPolicy: options?.includeUntracked ? 'opt-in-text' : 'metadata-only', ...(options?.includeUntracked ? { content: { source: 'filesystem' as const, contentId: null, state: 'omitted' as const, reason: 'UNSUPPORTED_PATH_ENCODING', sha256: null, byteLength: null, text: null, bytes: null } } : {}) }); continue;
    }
    const workspacePath = adapter.repository.path === '.' ? entry.path : `${adapter.repository.path}/${entry.path}`;
    const name = entry.path.split('/').at(-1)!;
    if (entry.path.split('/').some(part => excludedDirs.includes(part)) || config.excludePaths?.some(exclude => workspacePath === exclude || workspacePath.startsWith(`${exclude}/`)) || /^\.env(?:\.|$)|\.(?:pem|key)$|^id_(?:rsa|ed25519)/u.test(name)) { excludedUntrackedCount++; continue; }
    if (untracked.length >= adapter.limits.maxFiles) throw new ScanError('FILE_LIMIT', 'Untracked metadata exceeds maxFiles', 1);
    // Git for Windows may report an untracked directory/junction with a
    // trailing slash. Preserve Git's bytes while normalizing only the locator.
    const relative = entry.path.replace(/\/$/u, '');
    if (!await safePath(relative)) {
      untracked.push({ ...entry, type: 'unsafe-parent', size: null, contentPolicy: options?.includeUntracked ? 'opt-in-text' : 'metadata-only', ...(options?.includeUntracked ? { content: { source: 'filesystem' as const, contentId: null, state: 'omitted' as const, reason: 'WORKTREE_SYMLINK_BOUNDARY', sha256: null, byteLength: null, text: null, bytes: null } } : {}) });
      continue;
    }
    const filename = path.join(root, ...relative.split('/'));
    let captured = await fingerprint(filename, false);
    const item: Untracked = { ...entry, type: captured.type, size: captured.size, contentPolicy: options?.includeUntracked ? 'opt-in-text' : 'metadata-only' };
    if (options?.includeUntracked) {
      const content: FilesystemContent = { source: 'filesystem', contentId: null, state: 'omitted', reason: null, sha256: null, byteLength: captured.size, text: null, bytes: null };
      item.content = content;
      if (captured.type !== 'file') content.reason = 'UNTRACKED_FILE_TYPE';
      else if (captured.size! > adapter.limits.maxFileBytes) content.reason = 'UNTRACKED_FILE_LIMIT';
      else {
        try {
          captured = await fingerprint(filename, true, true); const bytes = retainedContents.get(filename); retainedContents.delete(filename);
          if (!bytes || captured.type !== 'file') throw new ScanError('SNAPSHOT_CHANGED', 'Untracked file disappeared during content capture', 1);
          content.sha256 = captured.hash; content.byteLength = bytes.length;
          if (bytes.subarray(0, 8000).includes(0)) content.reason = 'UNTRACKED_BINARY';
          else {
            try {
              const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
              const encoded = bytes.toString('base64'); const outputBytes = Buffer.byteLength(JSON.stringify([decoded, encoded]));
              if (bytes.includes(0)) content.reason = 'UNTRACKED_BINARY';
              else if (contentOutputBytes + outputBytes > adapter.limits.maxBundleBytes / 8) content.reason = 'UNTRACKED_OUTPUT_LIMIT';
              else { contentOutputBytes += outputBytes; content.state = 'collected'; if (options.retainContent) { content.text = decoded; content.bytes = encoded; } }
            }
            catch { content.reason = 'UNTRACKED_ENCODING'; }
          }
        } catch (error) {
          if (error instanceof ScanError) throw error;
          content.reason = 'UNTRACKED_READ_FAILED';
        }
      }
    }
    untracked.push(item); untrackedGuards.push({ pathBytes: entry.pathBytes, fingerprint: captured });
  }
  // The physical index is only an optimistic guard, never deterministic identity.
  const physicalIndex = await fingerprint(path.join(adapter.repository.gitDirectory!, 'index'), true);
  const shared = await adapter.required(['rev-parse', '--shared-index-path']); const sharedName = text(shared).trimEnd();
  const sharedIndex = sharedName ? await fingerprint(path.resolve(root, sharedName), true) : null;
  const effectiveConfiguration = [...configuration.values].filter(([key]) => /^(?:core\.(?:filemode|symlinks|autocrlf|eol|safecrlf|checkroundtripencoding|sparsecheckout|sparsecheckoutcone|ignorecase)$|filter\.|diff\..+\.(?:binary|wordregex|xfuncname|funcname)$|extensions\.(?:objectformat|worktreeconfig)$|submodule\..*\.(?:ignore|active)$|status\.)/u.test(key)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const semantic = { revisions, index, flags, intentToAdd, configurationHash: digest(effectiveConfiguration), attributes: attributes.map(({ key, fingerprint: file }) => ({ key, ...file, guard: undefined })), working: working.map(({ pathBytes, fingerprint: file }) => ({ pathBytes, ...file, guard: undefined })), status, untracked: untracked.map(item => ({ ...item, content: item.content ? { ...item.content, text: undefined, bytes: undefined } : undefined })), restrictedPaths };
  const guard = digest({ semantic, working, attributes, untrackedGuards, physicalIndex, sharedIndex, submoduleGuards });
  return { revisions, index, flags, intentToAdd, sparse, activeFilterPaths, restrictedPaths, immutableReasons: [...immutableReasons].sort(), status, untracked, excludedUntrackedCount, semantic, guard, trackedContents, configurationHash: semantic.configurationHash, attributesHash: digest(semantic.attributes), indexHash: digest({ index, flags, intentToAdd }), workingHash: digest(semantic.working), bytesHashed: attemptBytes };
}
