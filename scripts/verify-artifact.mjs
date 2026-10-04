import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8'));
assert.ok(process.env.npm_execpath, 'Run through npm run verify:artifact');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'difflearn-packed-'));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temporary, 'empty-git-config') };
function execute(executable, args, cwd, expected = 0, timeout = 120_000) {
  const result = spawnSync(executable, args, { cwd, env, shell: false, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.status, expected, `${path.basename(executable)} failed: ${result.stderr}`); return result;
}
const npm = (args, cwd = workspace) => execute(process.execPath, [process.env.npm_execpath, ...args], cwd);
async function files(directory, prefix = '') {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) output.push(...await files(path.join(directory, entry.name), relative + '/'));
    else output.push(relative);
  }
  return output;
}
try {
  await writeFile(env.GIT_CONFIG_GLOBAL, '');
  const sourceFiles = (await files(path.join(workspace, 'src'))).filter(file => file.endsWith('.ts')).map(file => 'dist/' + file.replace(/\.ts$/u, '.js'));
  const expectedFiles = [...sourceFiles, ...manifest.files.filter(file => file !== 'dist/**/*.js'), 'package.json'].sort();
  const inspect = metadata => {
    assert.equal(metadata.name, manifest.name); assert.equal(metadata.version, manifest.version); assert.deepEqual(metadata.bundled, []);
    assert.deepEqual(metadata.files.map(file => file.path).sort(), expectedFiles, 'Package allowlist differs from intended runtime/public documentation');
  };
  const dry = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts']).stdout); assert.equal(dry.length, 1); inspect(dry[0]);
  console.log(`Package inspection: ${expectedFiles.length} intended files; no bundled dependencies/source/tests/state.`);
  const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary]).stdout); assert.equal(packed.length, 1); inspect(packed[0]);
  assert.equal(path.basename(packed[0].filename), packed[0].filename);
  const tarball = path.join(temporary, packed[0].filename); const installation = path.join(temporary, 'isolated installation'); await mkdir(installation);
  const specifier = `file:../${path.basename(tarball)}`;
  const consumer = { name: 'synthetic-artifact-consumer', private: true, dependencies: { [manifest.name]: specifier } };
  const sourceLock = JSON.parse(await readFile(path.join(workspace, 'package-lock.json'), 'utf8'));
  const lockedRuntime = Object.fromEntries(Object.entries(sourceLock.packages).filter(([key, value]) => key && !value.dev));
  const artifactLock = { name: consumer.name, lockfileVersion: 3, requires: true, packages: {
    '': { name: consumer.name, dependencies: consumer.dependencies },
    ...lockedRuntime,
    [`node_modules/${manifest.name}`]: { version: manifest.version, resolved: specifier, integrity: packed[0].integrity, license: manifest.license, dependencies: manifest.dependencies, bin: manifest.bin, engines: manifest.engines },
  } };
  await writeFile(path.join(installation, 'package.json'), JSON.stringify(consumer));
  await writeFile(path.join(installation, 'package-lock.json'), JSON.stringify(artifactLock));
  npm(['ci', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], installation);
  const installed = path.join(installation, 'node_modules', manifest.name);
  assert.deepEqual((await files(installed)).sort(), expectedFiles, 'Installed tarball contents differ from inspected pack');
  const actualManifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8')); assert.equal(actualManifest.version, manifest.version); assert.equal(actualManifest.license, 'MIT');
  for (const [name, version] of Object.entries(manifest.dependencies)) assert.equal(JSON.parse(await readFile(path.join(installation, 'node_modules', name, 'package.json'), 'utf8')).version, version);
  assert.ok(!(await readdir(path.join(installation, 'node_modules'))).includes('typescript'), 'Dev dependencies leaked into consumer installation');
  const shim = path.join(installation, 'node_modules', '.bin', process.platform === 'win32' ? 'dr.cmd' : 'dr');
  const dr = (args, cwd = installation, expected = 0) => {
    if (process.platform !== 'win32') return execute(shim, args, cwd, expected);
    // Exercise npm's actual Windows .cmd shim, using literal PowerShell arguments.
    const literal = value => `'${value.replaceAll("'", "''")}'`;
    const command = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; & ${[shim, ...args].map(literal).join(' ')}; exit $LASTEXITCODE`;
    return execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], cwd, expected);
  };
  assert.match(dr(['--help']).stdout, /evidence/u); assert.equal(dr(['--version']).stdout.trim(), manifest.version);
  const repository = path.join(temporary, 'synthetic repo ไทย'); await mkdir(repository);
  const git = (...args) => execute('git', ['-c', 'core.autocrlf=false', ...args], repository);
  git('init', '-b', 'main'); git('config', 'user.name', 'Synthetic Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgSign', 'false');
  await writeFile(path.join(repository, '.git', 'fixture-ignore'), ''); await writeFile(path.join(repository, '.git', 'fixture-attributes'), '');
  git('config', 'core.excludesFile', '.git/fixture-ignore'); git('config', 'core.attributesFile', '.git/fixture-attributes');
  const filename = 'sample ไทย.txt'; await writeFile(path.join(repository, filename), 'before\n'); await writeFile(path.join(repository, 'sample.ts'), 'export const example = () => 1;\n'); git('add', '--', filename, 'sample.ts'); git('commit', '-m', 'synthetic baseline'); git('branch', 'baseline');
  await writeFile(path.join(repository, filename), 'after\n'); await writeFile(path.join(repository, 'sample.ts'), 'export const example = () => 2;\n'); git('add', '--', filename, 'sample.ts');
  const scan = JSON.parse(dr(['scan', '--root', repository, '--json']).stdout); assert.equal(scan.reportKind, 'scan'); assert.equal(scan.repositories.length, 1);
  const status = JSON.parse(dr(['status', '--root', repository, '--base', 'baseline', '--json']).stdout); assert.equal(status.reportKind, 'status'); assert.equal(status.completeness.state, 'complete');
  const diff = JSON.parse(dr(['diff', '--root', repository, '--base', 'baseline', '--scope', 'staged', '--json']).stdout); assert.equal(diff.reportKind, 'diff'); assert.equal(diff.completeness.state, 'complete'); assert.ok(diff.repositories[0].comparisons[0].files.some(file => file.destinationPath === filename && file.patch.hunks.length > 0));
  const result = dr(['evidence', '--root', repository, '--base', 'baseline', '--scope', 'staged', '--json']); assert.equal(result.stdout.trim().split('\n').length, 1);
  const evidence = JSON.parse(result.stdout); const { validateBundle } = await import(pathToFileURL(path.join(installed, 'dist', 'evidence', 'schema.js')).href);
  validateBundle(evidence); assert.equal(evidence.completeness.state, 'complete'); assert.ok(evidence.evidence.some(entry => entry.kind === 'file-change' && entry.data.destinationPath === filename)); assert.ok(evidence.evidence.some(entry => entry.kind === 'hunk' && entry.data.lines.some(line => line.kind === 'add' && line.content === 'after')));
  const context = dr(['context', '--root', repository, '--base', 'baseline', '--scope', 'staged', '--lang', 'th']).stdout; assert.match(context, /^# บริบท difflearn/u); assert.ok(context.includes(`evidence:${evidence.evidence[0].id}`));
  const reviewExport = path.join(temporary, 'review-evidence.json'); await writeFile(reviewExport, JSON.stringify(evidence));
  assert.match(dr(['review', '--help']).stdout, /mark/u);
  const firstHunk = evidence.evidence.find(entry => entry.kind === 'hunk'); assert.ok(firstHunk);
  const unseen = JSON.parse(dr(['review', 'list', '--root', repository, '--evidence', reviewExport, '--json']).stdout); assert.ok(unseen.rows.every(row => row.status === 'unseen')); assert.equal(unseen.statePresence, 'absent');
  const marked = JSON.parse(dr(['review', 'mark', '--root', repository, '--evidence', reviewExport, '--snapshot', firstHunk.snapshotId, '--hunk', firstHunk.id, '--json']).stdout); assert.ok(marked.rows.some(row => row.hunkEvidenceId === firstHunk.id && row.status === 'reviewed'));
  const { reviewOutputSchema } = await import(pathToFileURL(path.join(installed, 'dist', 'review', 'schema.js')).href); reviewOutputSchema.parse(marked);
  assert.match(dr(['review', 'list', '--root', repository, '--evidence', reviewExport, '--lang', 'th']).stdout, /ตรวจทานแล้ว/u);
  const reset = JSON.parse(dr(['review', 'reset', '--root', repository, '--json']).stdout); assert.equal(reset.removedAcknowledgments, 1); reviewOutputSchema.parse(reset);
  const invalid = JSON.parse(dr(['evidence', '--root', repository, '--scope', 'invalid', '--json'], installation, 2).stdout); assert.equal(invalid.reportKind, 'error');
  const syntax = JSON.parse(dr(['evidence', '--root', repository, '--base', 'baseline', '--scope', 'staged', '--symbols', '--json'], installation, 1).stdout);
  const { validateSyntaxBundle } = await import(pathToFileURL(path.join(installed, 'dist', 'evidence', 'syntax.js')).href); validateSyntaxBundle(syntax);
  assert.equal(syntax.schemaVersion, '1.1.0'); assert.equal(syntax.languageAnalysis.state, 'partial'); assert.ok(syntax.languageAnalysis.reasons.includes('SYMBOL_LANGUAGE_UNSUPPORTED')); assert.ok(syntax.evidence.some(entry => entry.kind === 'symbol' && entry.data.name === 'example')); assert.equal(syntax.languageAnalysis.capabilities.semanticReferences, false);
  const syntaxContext = dr(['context', '--root', repository, '--base', 'baseline', '--scope', 'staged', '--symbols', '--lang', 'th'], installation, 1).stdout; assert.match(syntaxContext, /v0.2/u);
  const candidates = JSON.parse(dr(['evidence', '--root', repository, '--base', 'baseline', '--scope', 'staged', '--references', '--related-tests', '--history', '--json'], installation, 1).stdout);
  const { validateCandidateBundle } = await import(pathToFileURL(path.join(installed, 'dist', 'evidence', 'candidates.js')).href); validateCandidateBundle(candidates);
  assert.equal(candidates.schemaVersion, '1.2.0'); assert.ok(candidates.evidence.some(entry => entry.kind === 'reference-candidate' && entry.confidence === 'candidate')); assert.ok(candidates.evidence.some(entry => entry.kind === 'history' && entry.data.commits.length)); assert.ok(candidates.evidence.filter(entry => entry.kind === 'related-test-query').every(entry => entry.data.testExecution === 'not-run'));
  await writeFile(reviewExport, JSON.stringify(candidates)); const candidateReview = JSON.parse(dr(['review', 'list', '--root', repository, '--evidence', reviewExport, '--json'], installation, 1).stdout); reviewOutputSchema.parse(candidateReview); assert.equal(candidateReview.reportKind, 'review'); assert.ok(candidateReview.rows.length > 0); assert.equal(candidateReview.inputCompleteness, 'partial');
  const candidateContext = dr(['context', '--root', repository, '--base', 'baseline', '--scope', 'staged', '--references', '--related-tests', '--history'], installation, 1).stdout; assert.match(candidateContext, /not confirm callers or dependencies/u); assert.match(candidateContext, /missing test nor a coverage gap/u);
  console.log(`Installed ${manifest.name}@${manifest.version}: actual ${path.basename(shim)} help/version, scan/status/diff/evidence, Thai context, JSON error, syntax/candidate/history partial coverage and explicit review mark/list/reset verified on ${process.platform}; synthetic Thai/space paths.`);
} finally {
  // Only remove the absolute directory returned by this mkdtemp call.
  const relative = path.relative(os.tmpdir(), temporary); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await rm(temporary, { recursive: true, force: true });
}
