import { readFile } from 'node:fs/promises';
import { ScanError, loadConfig } from '../config/load.js';
import { defaultLimits, resolveLimits } from '../config/schema.js';
import { canonicalRoot, discover } from '../git/discovery.js';
import { runGit } from '../git/runner.js';
import { collectRepository } from '../git/collector.js';
import { patchOptions } from '../git/adapter.js';
import { buildBundle } from '../evidence/bundle.js';
import { extendSyntaxBundle } from '../evidence/syntax.js';
import { extendJavaSyntaxBundle } from '../evidence/java-syntax.js';

export async function findLocalRepository(cwd: string, signal?: AbortSignal) {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'], defaultLimits, signal);
  signal?.throwIfAborted();
  if (result.code !== 0) {
    if (/not a git repository|must be run in a work tree/iu.test(result.stderr)) throw new ScanError('REPOSITORY_REQUIRED', 'Run dr inside a Git repository (or one of its subdirectories).', 1);
    throw new ScanError('GIT_REPOSITORY_UNAVAILABLE', `Git could not open this repository. Resolve the Git error and run dr again: ${result.stderr.trim().slice(0, 2048)}`, 1);
  }
  const decoded = result.stdout.toString('utf8');
  if (!Buffer.from(decoded).equals(result.stdout)) throw new ScanError('UNSUPPORTED_PATH_ENCODING', 'The repository path cannot be displayed as UTF-8.', 1);
  const root = await canonicalRoot(decoded.replace(/\r?\n$/u, ''));
  const symbolic = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], defaultLimits, signal);
  signal?.throwIfAborted();
  return { root, branch: symbolic.code === 0 ? symbolic.stdout.toString('utf8').trimEnd() : null };
}

export async function collectLocalEvidence(root: string, signal: AbortSignal) {
  const startedAt = new Date().toISOString(), loaded = await loadConfig(root, undefined);
  // Local app collection is confined to this worktree; workspace scans remain explicit commands.
  const config = { ...loaded.config, repositories: loaded.config.repositories?.filter(repository => repository.path === '.') };
  const limits = resolveLimits(config.limits);
  const git = await runGit(root, ['--version'], limits, signal), gitVersion = git.stdout.toString('utf8').trim();
  const match = /^git version (\d+)\.(\d+)/u.exec(gitVersion);
  if (git.code !== 0 || !match || Number(match[1]) < 2 || Number(match[1]) === 2 && Number(match[2]) < 49) throw new ScanError('GIT_UNSUPPORTED', 'Install Git 2.49 or newer, then click Refresh.', 1);
  const found = await discover(root, config, limits, ['.'], undefined, signal, true);
  const repositories = [], budget = { workspaceBytes: 0 };
  for (const repository of found.repositories) repositories.push(await collectRepository(repository, config, limits, budget, 'HEAD', signal, undefined, { scope: 'all', includeUntracked: false, symbols: true, java: true }));
  signal.throwIfAborted();
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  const gitBundle = buildBundle({ collector: { name: 'difflearn', version, gitVersion }, collection: { startedAt, endedAt: new Date().toISOString() },
    request: { root, configPath: loaded.configPath, repositories: ['.'], base: 'HEAD', scopes: ['all'], contentPolicy: 'metadata-only', comparisonOptions: patchOptions, immutableAttributeSource: 'captured-head', limits },
    discovery: found.discovery, discoveryCompleteness: found.completeness, repositories, diagnostics: [...found.diagnostics, ...repositories.flatMap(repository => repository.diagnostics)] });
  const hasJava = repositories.some(repository => repository.comparisons.some(comparison => comparison.files.some(file => file.languageAnalysis?.sources.some(source => source.language === 'java'))));
  return hasJava ? extendJavaSyntaxBundle(gitBundle, repositories) : extendSyntaxBundle(gitBundle, repositories);
}
