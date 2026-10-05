import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { canonicalRoot, discover } from '../src/git/discovery.js';
import { resolveLimits } from '../src/config/schema.js';
import { collectRepository } from '../src/git/collector.js';
import { runGit, type GitRunner } from '../src/git/runner.js';
import { patchOptions, type Scope } from '../src/git/adapter.js';
import { buildBundle } from '../src/evidence/bundle.js';
import { extendJavaSyntaxBundle, validateJavaSyntaxBundle, javaSyntaxOutputSchema } from '../src/evidence/java-syntax.js';
import { readEvidenceBundle } from '../src/evidence/read.js';
import { createLanguageParser, TreeSitterAnalyzer } from '../src/language/tree-sitter.js';
import { syntaxId } from '../src/evidence/syntax.js';
import { renderContext } from '../src/output/context.js';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const limits = resolveLimits(undefined), config = { configVersion: '1' as const };
function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args], { cwd: root, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), timeout: 30000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr.toString()); return result.stdout;
}
async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'difflearn-java-'));
  try {
    git(root, 'init', '-b', 'main'); git(root, 'config', 'core.autocrlf', 'false'); git(root, 'config', 'core.hooksPath', '.git/no-fixture-hooks');
    for (const file of ['ignore', 'attributes']) await writeFile(path.join(root, '.git', `fixture-${file}`), '');
    git(root, 'config', 'core.excludesFile', '.git/fixture-ignore'); git(root, 'config', 'core.attributesFile', '.git/fixture-attributes'); await fn(root);
  } finally { const relative = path.relative(os.tmpdir(), root); assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); await rm(root, { recursive: true, force: true }); }
}
async function baseline(root: string, content: string, filename = 'บริการ.java') { await writeFile(path.join(root, filename), content); git(root, 'add', '.'); git(root, 'commit', '-m', 'synthetic Java'); git(root, 'branch', 'base'); }
async function collect(root: string, scope: Scope = 'staged', runner: GitRunner = runGit) {
  const canonical = await canonicalRoot(root), found = await discover(canonical, config, limits);
  const repository = await collectRepository(found.repositories[0]!, config, limits, { workspaceBytes: 0 }, 'base', undefined, runner, { scope, includeUntracked: false, symbols: true });
  const time = '2026-10-05T00:00:00.000Z';
  const base = buildBundle({ collector: { name: 'difflearn', version: 'fixture', gitVersion: 'fixture' }, collection: { startedAt: time, endedAt: time }, request: { root: canonical, configPath: null, repositories: [], base: 'base', scopes: [scope], contentPolicy: 'metadata-only', comparisonOptions: patchOptions, immutableAttributeSource: 'captured-head', limits }, discovery: found.discovery, repositories: [repository], diagnostics: repository.diagnostics, discoveryCompleteness: found.completeness });
  return { repository, base, bundle: extendJavaSyntaxBundle(base, [repository]) };
}
const source = (value: string) => `package synthetic;\r\npublic class บริการ {\r\n  public String ชื่อ() {\r\n    return "${value}😀";\r\n  }\r\n}\r\n`;

test('pinned Java grammar loads and parses ABI 14 on the existing runtime, including records and Unicode', async () => {
  assert.equal(new TreeSitterAnalyzer().languageForPath('บริการ.JAVA'), 'java');
  const parser = createLanguageParser('java'); const tree = parser.parse('package synthetic; record Sample(String ชื่อ) { Sample { System.out.println("ไทย😀"); } }');
  assert.equal(tree.rootNode.hasError, false); assert.match(tree.rootNode.toString(), /compact_constructor_declaration/u);
  assert.match((await readFile(new URL('../../node_modules/tree-sitter-java/src/parser.c', import.meta.url), 'utf8')).slice(0, 1000), /LANGUAGE_VERSION 14/u);
});
test('Java all scopes retain authoritative before/after CRLF bytes, ranges, hashes, hunk links and default Git IDs', async () => fixture(async root => {
  await baseline(root, source('base')); await writeFile(path.join(root, 'บริการ.java'), source('head')); git(root, 'commit', '-am', 'head'); await writeFile(path.join(root, 'บริการ.java'), source('index')); git(root, 'add', '.'); await writeFile(path.join(root, 'บริการ.java'), source('working'));
  for (const [scope, before, after] of [['branch', 'base', 'head'], ['staged', 'head', 'index'], ['unstaged', 'index', 'working'], ['all', 'base', 'working']] as const) {
    const { bundle, base, repository } = await collect(root, scope); assert.equal(repository.state, 'complete', JSON.stringify(repository.diagnostics)); assert.equal(bundle.languageAnalysis.state, 'complete', JSON.stringify(bundle.languageAnalysis));
    assert.deepEqual(bundle.evidence.filter(entry => entry.kind !== 'language-analysis' && entry.kind !== 'symbol'), base.evidence); assert.equal(base.schemaVersion, '1.0.0');
    const analysis = bundle.evidence.find(entry => entry.kind === 'language-analysis'); assert.ok(analysis?.kind === 'language-analysis'); assert.deepEqual(analysis.data.sources.map(side => side.sha256), [hash(source(before)), hash(source(after))]);
    assert.equal(analysis.data.sources[1]!.origin, scope === 'branch' || scope === 'staged' ? 'git-blob' : 'filesystem');
    const symbols = bundle.evidence.filter(entry => entry.kind === 'symbol'); assert.equal(symbols.length, 2);
    for (const entry of symbols) {
      const bytes = Buffer.from(source(entry.data.side === 'before' ? before : after)); assert.equal(entry.data.name, 'ชื่อ'); assert.equal(entry.data.kind, 'method'); assert.equal(entry.data.matching, 'candidate');
      assert.equal(hash(bytes.subarray(entry.data.range.startByte, entry.data.range.endByte)), entry.data.contentHash); assert.ok(entry.data.scope.some(scope => scope.name === 'บริการ'));
      assert.ok(entry.data.hunkEvidenceIds.every(id => bundle.evidence.some(other => other.id === id && other.kind === 'hunk')));
      assert.equal(entry.data.range.startColumn, 2); assert.equal(entry.data.range.startLine, 3);
    }
    assert.equal(readEvidenceBundle(bundle).schemaVersion, '1.3.0');
    if (scope === 'staged') {
      const malformed = structuredClone(bundle), changed = malformed.evidence.find(entry => entry.kind === 'symbol' && entry.data.side === 'after'); assert.ok(changed?.kind === 'symbol');
      changed.data.signatureDisplay = 'ชื่อ(String altered)'; changed.id = syntaxId(changed); malformed.languageAnalysis.evidenceIds = malformed.evidence.filter(entry => entry.kind === 'symbol' || entry.kind === 'language-analysis').map(entry => entry.id);
      assert.throws(() => validateJavaSyntaxBundle(malformed), { code: 'INTERNAL_CONTRACT_ERROR' });
    }
  }
}));

test('a changed unique Java parameter signature remains unmatched rather than implying continuity', async () => fixture(async root => {
  await baseline(root, 'class Sample {\n int unique(int value) { return 1; }\n}\n');
  await writeFile(path.join(root, 'บริการ.java'), 'class Sample {\n int unique(String value) { return 2; }\n}\n'); git(root, 'add', '.');
  const { bundle } = await collect(root); const methods = bundle.evidence.filter(entry => entry.kind === 'symbol' && entry.data.name === 'unique'); assert.equal(methods.length, 2); assert.ok(methods.every(entry => entry.kind === 'symbol' && entry.data.matching === 'unmatched' && entry.data.counterpartOrdinal === null));
}));
test('Java packages, static imports, types, annotations, constructors, multi-fields, initializers and nested boundaries are declarations', async () => fixture(async root => {
  await baseline(root, '// empty baseline\n');
  const content = `package synthetic.demo;
import java.util.List;
import static java.util.Collections.emptyList;
@Deprecated
class Sample {
  int first = 1, second = 2;
  Sample() { first = 3; }
  static { System.out.println("ไทย"); }
  { first = 4; }
  @Deprecated
  String choose() { return "ไทย😀"; }
  class Nested { int nested; }
  void boundaries() {
    class Local { void local() {} }
    Runnable lambda = () -> System.out.println("lambda");
    Runnable anonymous = new Runnable() { public void run() {} };
    int localVariable = 1;
  }
}
interface Contract { String value(); }
record Row(String ชื่อ, int count) { Row { if (count < 0) throw new IllegalArgumentException(); } }
enum Mode { FIRST, SECOND; }
@interface Marker { String value() default "synthetic"; }
`;
  await writeFile(path.join(root, 'บริการ.java'), content); git(root, 'add', '.');
  const { bundle } = await collect(root); assert.equal(bundle.languageAnalysis.state, 'complete', JSON.stringify(bundle.languageAnalysis));
  const symbols = bundle.evidence.filter(entry => entry.kind === 'symbol');
  for (const kind of ['package', 'import', 'class', 'interface', 'record', 'record-component', 'enum', 'enum-constant', 'annotation-type', 'annotation-element', 'annotation', 'method', 'constructor', 'field', 'initializer', 'anonymous-class', 'lambda']) assert.ok(symbols.some(entry => entry.data.kind === kind), kind);
  for (const name of ['first', 'second', 'nested', 'Local', 'local']) assert.ok(symbols.some(entry => entry.data.name === name), name);
  assert.ok(!symbols.some(entry => entry.data.name === 'localVariable' || entry.data.name === 'lambda' || entry.data.name === 'anonymous'));
  assert.ok(symbols.some(entry => entry.data.name === 'run' && entry.data.scope.some(scope => scope.kind === 'anonymous-class' && scope.name === null)));
  assert.ok(symbols.filter(entry => ['lambda', 'anonymous-class', 'initializer'].includes(entry.data.kind)).every(entry => entry.data.name === null));
  for (const entry of symbols.filter(entry => entry.data.side === 'after')) assert.equal(entry.data.contentHash, hash(Buffer.from(content).subarray(entry.data.range.startByte, entry.data.range.endByte)));
}));
test('deleted Java declarations, overload ambiguity, syntax errors and unsupported peers remain explicit partial evidence', async () => fixture(async root => {
  await baseline(root, 'class Gone {\n  void deleted() {}\n}\n');
  await writeFile(path.join(root, 'Other.java'), 'class Other {\n  Other() {}\n  Other(int value) {}\n  int repeat(int v) { return 1; }\n  int repeat(String v) { return 2; }\n  void broken() {}\n}\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'overloads');
  git(root, 'rm', 'บริการ.java'); await writeFile(path.join(root, 'Other.java'), 'class Other {\n  Other() { System.out.println(1); }\n  Other(int value) { System.out.println(2); }\n  int repeat(int v) { return 3; }\n  int repeat(String v) { return 4; }\n  void broken( {\n}\n'); await writeFile(path.join(root, 'unsupported.py'), 'def example(): return 1\n'); git(root, 'add', '.');
  const { bundle } = await collect(root); assert.equal(bundle.completeness.state, 'partial');
  for (const reason of ['SYMBOL_MATCH_AMBIGUOUS', 'SYMBOL_SYNTAX_ERROR', 'SYMBOL_LANGUAGE_UNSUPPORTED']) assert.ok(bundle.languageAnalysis.reasons.includes(reason), reason);
  const symbols = bundle.evidence.filter(entry => entry.kind === 'symbol'); assert.ok(symbols.some(entry => entry.data.name === 'deleted' && entry.data.side === 'before')); assert.ok(!symbols.some(entry => entry.data.name === 'deleted' && entry.data.side === 'after'));
  assert.ok(symbols.filter(entry => entry.data.name === 'repeat' || entry.data.kind === 'constructor').every(entry => entry.data.matching === 'ambiguous' && entry.data.counterpartOrdinal === null));
  assert.ok(!symbols.some(entry => entry.data.name === 'broken' && entry.data.side === 'after'));
  assert.ok(bundle.evidence.some(entry => entry.kind === 'hunk')); assert.match(renderContext(bundle, 'th').markdown, /TS\/TSX\/JS\/Java/u);
  const malformed = structuredClone(bundle); const symbol = malformed.evidence.find(entry => entry.kind === 'symbol')!;
  if (symbol.kind === 'symbol') { symbol.data.range.endByte = Number.MAX_SAFE_INTEGER; symbol.id = syntaxId(symbol); malformed.languageAnalysis.evidenceIds = malformed.evidence.filter(entry => entry.kind === 'symbol' || entry.kind === 'language-analysis').map(entry => entry.id); }
  assert.throws(() => validateJavaSyntaxBundle(malformed), { code: 'INTERNAL_CONTRACT_ERROR' });
}));
test('Java source/output bounds and actual mutations retain Git evidence or discard the entire changed snapshot', async () => fixture(async root => {
  await baseline(root, source('base')); await writeFile(path.join(root, 'บริการ.java'), source('index')); git(root, 'add', '.');
  const { repository } = await collect(root); const file = repository.comparisons[0]!.files[0]!; const result = file.languageAnalysis!;
  const limited = new TreeSitterAnalyzer().analyze({ sources: result.sources.map(snapshot => ({ snapshot, bytes: Buffer.from(source(snapshot.side === 'before' ? 'base' : 'index')) })), patch: file.patch!, maxSymbols: 1 });
  assert.equal(limited.symbols.length, 1); assert.equal(limited.omittedSymbols, 1); assert.ok(limited.reasons.includes('SYMBOL_OUTPUT_LIMIT'));
  let changes = 0; const mutating: GitRunner = async (...args) => { const output = await runGit(...args); if (args[1].includes('--patch')) await writeFile(path.join(root, 'บริการ.java'), source(String(++changes))); return output; };
  const unstable = await collect(root, 'all', mutating); assert.equal(unstable.repository.snapshot.consistency, 'inconsistent'); assert.equal(unstable.bundle.evidence.length, 0);
}));
test('frozen historical exports validate without loading native grammars and Java schema generation is separate', async () => {
  const fixtureDirectory = fileURLToPath(new URL('../../tests/fixtures/evidence/', import.meta.url));
  for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
    const value: unknown = JSON.parse(await readFile(path.join(fixtureDirectory, `${version}.json`), 'utf8')); assert.equal(readEvidenceBundle(value).schemaVersion, version);
  }
  const reader = pathToFileURL(fileURLToPath(new URL('../../dist/evidence/read.js', import.meta.url))).href;
  const code = `import { registerHooks } from 'node:module'; import { readFile } from 'node:fs/promises'; registerHooks({resolve(s,c,n){if(s.startsWith('tree-sitter'))throw new Error('Native parser must not load');return n(s,c);}}); const {readEvidenceBundle}=await import(${JSON.stringify(reader)}); for(const v of ['1.0.0','1.1.0','1.2.0'])readEvidenceBundle(JSON.parse(await readFile(${JSON.stringify(fixtureDirectory)}+'/'+v+'.json','utf8')));`;
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30000 }); assert.ifError(output.error); assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(JSON.parse(await readFile(new URL('../../docs/java-syntax-evidence.schema.json', import.meta.url), 'utf8')), z.toJSONSchema(javaSyntaxOutputSchema, { target: 'draft-2020-12', io: 'input' }));
  assert.throws(() => readEvidenceBundle({ schemaVersion: '9.0.0' }), { code: 'EVIDENCE_VERSION_UNSUPPORTED' });
});
