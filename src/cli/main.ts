#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command, CommanderError } from 'commander';
import { loadConfig, parseConfig, ScanError } from '../config/load.js';
import { isRelativePath, resolveLimits } from '../config/schema.js';
import { canonicalRoot, discover } from '../git/discovery.js';
import { runGit } from '../git/runner.js';
import { renderScan } from '../output/scan.js';
import { renderStatus } from '../output/status.js';
import { renderDiff } from '../output/diff.js';
import { collectRepository, type RepositoryStatus } from '../git/collector.js';
import { diffOptions, patchOptions, type Scope } from '../git/adapter.js';
import { buildBundle } from '../evidence/bundle.js';
import { errorSchema } from '../evidence/schema.js';
import { extendSyntaxBundle } from '../evidence/syntax.js';
import { extendCandidateBundle } from '../candidates/collect.js';
import { discoveryDefaults } from '../candidates/contracts.js';
import { discoveryRequestSchema } from '../evidence/candidates.js';
import { renderContext } from '../output/context.js';
import { messages, diagnosticMessage, type Locale } from '../output/locale.js';
import { registerReview } from './review.js';

const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
const jsonRequested = process.argv[2] === 'evidence' || process.argv.slice(2).some(arg => arg === '--json');
let humanLocale: Locale = process.argv.some((arg, index) => arg === '--lang=th' || arg === '--lang' && process.argv[index + 1] === 'th') ? 'th' : 'en';
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.stdout.on('error', () => { process.exitCode = 1; });
process.stderr.on('error', () => { process.exitCode = 1; });
const program = new Command().name('dr').description('difflearn: local Git discovery, status, and diff evidence.').version(version)
  .argument('[command]', 'reserved for future commands')
  .allowExcessArguments(false).exitOverride()
  .configureOutput({ writeErr: () => { /* errors are rendered once by the catch boundary */ } })
  .addHelpText('after', '\nImplemented: scan, status, diff, evidence, context, review, --help, --version.\nEvidence emits validated JSON by default. Context emits escaped English/Thai Markdown.\nv0.1 provides Git/filesystem/diff facts; symbols, references, impact and test coverage analysis are unsupported.\nOpt-in evidence/context --symbols adds v0.2 syntax declarations for TS/TSX/JS only; no semantic references or behavior claims.\nreview mark/list/reset manage explicit local acknowledgments separately from evidence.')
  .action((command: string | undefined) => {
    if (command !== undefined) throw new ScanError('COMMAND_UNAVAILABLE', `Command ${JSON.stringify(command)} is not implemented. Run dr --help.`);
    program.help();
  });

type Options = { root?: string; config?: string; repo?: string[]; lang?: string; maxDepth?: string; concurrency?: string; json?: boolean; base?: string; scope?: string; includeUntracked?: boolean; maxFileBytes?: string; maxPatchBytes?: string; symbols?: boolean; references?: boolean; relatedTests?: boolean; history?: boolean; maxSymbols?: string; maxResults?: string; maxHistory?: string };
for (const kind of ['scan', 'status', 'diff', 'evidence', 'context'] as const) {
const command = program.command(kind).description(kind === 'scan' ? 'Discover repositories with explicit coverage and configured bases' : kind === 'status' ? 'Collect HEAD, base, branch changes, and separate index/worktree status' : kind === 'diff' ? 'Collect one direct Git comparison with validated unified hunks' : kind === 'evidence' ? 'Emit a runtime-validated v0.1 evidence bundle (JSON by default)' : 'Render cited evidence as escaped English/Thai Markdown; source is untrusted')
  .option('--root <directory>', 'workspace directory (default cwd)')
  .option('--config <file>', 'explicit JSON config (relative to invocation cwd)')
  .option('--repo <path>', 'select an exact workspace-relative repository (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
  .option('--lang <locale>', 'human output locale: en or th')
  .option('--max-depth <n>', 'maximum traversal depth (root is zero)')
  .option('--concurrency <n>', 'maximum subprocess concurrency (1..32)');
if (kind !== 'context') command.option('--json', kind === 'evidence' ? 'explicit JSON mode (already the default)' : 'emit one English-keyed JSON report');
if (kind !== 'scan') command.option('--base <revision>', 'explicit base for every selected repository; never fetches or guesses');
if (kind === 'evidence' || kind === 'context') command.option('--symbols', 'opt in to bounded TS/TSX/JS syntax declarations (schema 1.1.0); no semantic references')
  .option('--references', 'fixed-string reference candidates across selected repository snapshots; implies --symbols (schema 1.2.0)')
  .option('--related-tests', 'potential tests from filename/text/import heuristics; not run; implies --symbols')
  .option('--history', 'bounded literal-path history from pinned HEAD; implies --symbols')
  .option('--max-symbols <n>', 'maximum symbol queries and history file queries (1..256, default 32)')
  .option('--max-results <n>', 'maximum reference matches / related tests per symbol (1..1000, default 50)')
  .option('--max-history <n>', 'maximum commits per file history query (1..200, default 20)');
if (kind === 'diff' || kind === 'evidence' || kind === 'context') command.option('--scope <scope>', 'comparison: branch, staged, unstaged, all (default all)')
  .option('--include-untracked', 'opt in to bounded UTF-8 filesystem text; separate from Git patches')
  .option('--max-file-bytes <n>', 'maximum bytes per patch file section or untracked text file')
  .option('--max-patch-bytes <n>', 'maximum retained Git patch bytes per repository');
command.action(async (options: Options) => {
    const scalar = new Set(['--root', '--config', '--lang', '--max-depth', '--concurrency', '--json', '--base', '--scope', '--include-untracked', '--max-file-bytes', '--max-patch-bytes', '--symbols', '--references', '--related-tests', '--history', '--max-symbols', '--max-results', '--max-history']);
    const supplied = new Set<string>();
    for (const argument of process.argv.slice(3)) {
      const flag = argument.split('=')[0]!;
      if (scalar.has(flag)) {
        if (supplied.has(flag)) throw new ScanError('ARGUMENT_INVALID', `Duplicate scalar flag ${flag}`);
        supplied.add(flag);
      }
    }
    const root = await canonicalRoot(options.root ?? process.cwd());
    const loaded = await loadConfig(root, options.config);
    const overrides: Record<string, number> = {};
    for (const [key, raw] of [['maxDepth', options.maxDepth], ['concurrency', options.concurrency], ['maxFileBytes', options.maxFileBytes], ['maxPatchBytes', options.maxPatchBytes]] as const) {
      if (raw !== undefined) {
        if (!/^\d+$/u.test(raw)) throw new ScanError('ARGUMENT_INVALID', `${key} must be an integer`);
        overrides[key] = Number(raw);
      }
    }
    const config = parseConfig(JSON.stringify({ ...loaded.config, lang: options.lang ?? loaded.config.lang ?? 'en', limits: { ...loaded.config.limits, ...overrides } }));
    humanLocale = config.lang ?? 'en';
    const limits = resolveLimits(config.limits);
    const selections = [...new Set((options.repo ?? []).map(value => value.replaceAll('\\', '/')))];
    if (selections.some(value => !isRelativePath(value))) throw new ScanError('ARGUMENT_INVALID', '--repo requires a literal workspace-relative path');
    if (options.base !== undefined && (!options.base.length || options.base.includes('\0'))) throw new ScanError('ARGUMENT_INVALID', '--base requires a nonempty revision without NUL');
    const scope = options.scope ?? 'all';
    if (!['branch', 'staged', 'unstaged', 'all'].includes(scope)) throw new ScanError('ARGUMENT_INVALID', '--scope must be branch, staged, unstaged, or all');
    const candidateRequested = Boolean(options.references || options.relatedTests || options.history);
    const candidateInput = { references: options.references ?? false, relatedTests: options.relatedTests ?? false, history: options.history ?? false, ...discoveryDefaults };
    for (const [key, raw] of [['maxSymbols', options.maxSymbols], ['maxResults', options.maxResults], ['maxHistory', options.maxHistory]] as const) if (raw !== undefined) { if (!/^\d+$/u.test(raw) || !candidateRequested) throw new ScanError('ARGUMENT_INVALID', `${key} requires an integer and a candidate/history flag`); candidateInput[key] = Number(raw); }
    const validatedDiscovery = discoveryRequestSchema.safeParse(candidateInput); if (!validatedDiscovery.success) throw new ScanError('ARGUMENT_INVALID', 'Candidate limits exceed their documented bounds');
    const diffRequest = kind !== 'scan' && kind !== 'status' ? { scope: scope as Scope, includeUntracked: options.includeUntracked ?? false, symbols: Boolean(options.symbols || candidateRequested) } : undefined;
    const start = new Date().toISOString();
    const git = await runGit(root, ['--version'], limits, controller.signal);
    const gitVersion = git.stdout.toString('utf8').trim();
    const match = /^git version (\d+)\.(\d+)/u.exec(gitVersion);
    if (git.code !== 0 || !match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 49)) throw new ScanError('GIT_UNSUPPORTED', 'Git >=2.49 is required', 1);
    const result = await discover(root, config, limits, selections, undefined, controller.signal);
    if (controller.signal.aborted) throw new ScanError('INTERRUPTED', 'Scan interrupted', 1);
    let report;
    let rendered: string;
    let renderingPartial = false;
    if (kind !== 'scan') {
      const repositories: RepositoryStatus[] = []; const budget = { workspaceBytes: 0 }; let retainedBytes = 0; let outputExhausted = false;
      for (const repository of result.repositories) {
        let collected = await collectRepository(outputExhausted ? { ...repository, kind: 'failed' } : repository, config, limits, budget, options.base, controller.signal, undefined, diffRequest);
        collected.diagnostics.push(...result.diagnostics.filter(item => item.path === repository.path).map(item => ({ ...item, severity: 'warning' as const, repositoryId: repository.repositoryId, scope: null })));
        const bytes = Buffer.byteLength(JSON.stringify(collected)) + Buffer.byteLength(JSON.stringify(collected.diagnostics));
        if (outputExhausted || retainedBytes + bytes > limits.maxBundleBytes / 2) {
          const hashed = collected.snapshot.bytesHashed;
          collected = await collectRepository({ ...repository, kind: 'failed' }, config, limits, budget, options.base, controller.signal);
          collected.kind = repository.kind; collected.reasons = ['BUNDLE_LIMIT']; collected.snapshot.bytesHashed = hashed;
          collected.diagnostics = [{ code: 'BUNDLE_LIMIT', severity: 'warning', stage: 'collection', repositoryId: repository.repositoryId, path: repository.path, scope: null, message: 'Repository data omitted at the deterministic workspace output budget' }];
          outputExhausted = true;
        } else retainedBytes += bytes;
        repositories.push(collected);
      }
      if (controller.signal.aborted) throw new ScanError('INTERRUPTED', 'Collection interrupted', 1);
      const reasons = [...new Set([...result.completeness.reasons, ...repositories.flatMap(repo => repo.reasons)])].sort();
      const state = result.completeness.state === 'complete' && repositories.every(repo => repo.state === 'complete') ? 'complete' : repositories.some(repo => repo.revisions !== null) || repositories.length === 0 && result.discovery.readableDirectories > 0 ? 'partial' : 'failed';
      const diagnostics = [...result.diagnostics.filter(item => !repositories.some(repo => repo.path === item.path)), ...repositories.flatMap(repo => repo.diagnostics)];
      const collectedReport = { schemaVersion: '1.0.0', reportKind: kind, collector: { name: 'difflearn', version, gitVersion }, collection: { startedAt: start, endedAt: new Date().toISOString() }, request: { root, configPath: loaded.configPath, repositories: selections, base: options.base ?? null, scopes: diffRequest ? [diffRequest.scope] : ['branch', 'staged', 'unstaged', 'all'], contentPolicy: diffRequest?.includeUntracked ? 'opt-in-text' : 'metadata-only', comparisonOptions: diffRequest ? patchOptions : diffOptions, immutableAttributeSource: 'captured-head', limits }, discovery: result.discovery, repositories, diagnostics, completeness: { state, reasons, repositoryStates: repositories.map(repo => ({ repositoryId: repo.repositoryId, state: repo.state })), omittedCount: state === 'complete' ? 0 : null }, evidence: [] };
      if (kind === 'evidence' || kind === 'context') {
        const gitBundle = buildBundle({ ...collectedReport, discoveryCompleteness: result.completeness });
        const syntaxBundle = diffRequest?.symbols ? extendSyntaxBundle(gitBundle, repositories) : null;
        const bundle = candidateRequested && syntaxBundle ? await extendCandidateBundle(syntaxBundle, repositories, config, limits, budget, validatedDiscovery.data, options.base, controller.signal) : syntaxBundle ?? gitBundle; report = bundle;
        if (kind === 'context') {
          const context = renderContext(bundle, humanLocale); rendered = context.markdown;
          renderingPartial = context.omittedEvidenceIds.length > 0 || context.omittedDiagnostics > 0;
          if (renderingPartial) process.stderr.write(`${messages(humanLocale).warning} [CONTEXT_OUTPUT_LIMIT]: ${diagnosticMessage('CONTEXT_OUTPUT_LIMIT', humanLocale)} (${context.omittedEvidenceIds.length}, ${context.omittedDiagnostics})\n`);
        } else rendered = '';
      } else { report = collectedReport; rendered = kind === 'diff' ? renderDiff(repositories, root, state, humanLocale) : renderStatus(repositories, root, state, humanLocale); }
    } else {
      report = { schemaVersion: '1.0.0', reportKind: 'scan', collector: { name: 'difflearn', version, gitVersion }, collection: { startedAt: start, endedAt: new Date().toISOString() }, request: { root, configPath: loaded.configPath, repositories: selections, limits }, ...result, evidence: [] };
      rendered = renderScan(result, root, config.lang ?? 'en');
    }
    if (Buffer.byteLength(JSON.stringify(report)) > limits.maxBundleBytes) throw new ScanError('BUNDLE_LIMIT', 'Scan report exceeds maxBundleBytes; increase the budget or narrow the workspace', 1);
    for (const item of report.diagnostics) process.stderr.write(`${messages(humanLocale).warning} [${item.code}] ${JSON.stringify(item.path)}: ${humanLocale === 'th' ? `${diagnosticMessage(item.code, humanLocale)} ` : ''}${JSON.stringify(item.message)}\n`);
    process.stdout.write(options.json || kind === 'evidence' ? `${JSON.stringify(report)}\n` : rendered);
    process.exitCode = report.completeness.state === 'complete' && !renderingPartial ? 0 : 1;
  });
}

registerReview(program, controller.signal);
try { await program.parseAsync(process.argv); }
catch (error: unknown) {
  if (error instanceof CommanderError && error.exitCode === 0) process.exitCode = 0;
  else {
    const code = controller.signal.aborted ? 'INTERRUPTED' : error instanceof ScanError ? error.code : error instanceof CommanderError ? 'ARGUMENT_INVALID' : 'INTERNAL_ERROR';
    const message = controller.signal.aborted ? 'Scan interrupted' : error instanceof Error ? error.message : 'Unexpected failure';
    process.exitCode = controller.signal.aborted ? 130 : error instanceof ScanError ? error.exitCode : error instanceof CommanderError ? 2 : 1;
    process.stderr.write(`${messages(humanLocale).error} [${code}]: ${JSON.stringify(message)}\n`);
    if (jsonRequested) {
      const envelope = errorSchema.safeParse({ schemaVersion: '1.0.0', reportKind: 'error', completeness: { state: 'failed' }, diagnostics: [{ code, severity: 'error', message }] });
      process.stdout.write(`${JSON.stringify(envelope.success ? envelope.data : { schemaVersion: '1.0.0', reportKind: 'error', completeness: { state: 'failed' }, diagnostics: [{ code: 'INTERNAL_CONTRACT_ERROR', severity: 'error', message: 'Invalid error envelope' }] })}\n`);
    }
  }
}
