import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entrypoint = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    shell: false,
  });
  assert.ifError(result.error);
  return result;
}

test('the built binary has an LF shebang for Unix executable compatibility', () => {
  assert.ok(readFileSync(entrypoint, 'utf8').startsWith('#!/usr/bin/env node\n'));
});

test('help lists implemented commands, Java syntax and read-only UI with unsupported semantic claims', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage: dr/);
  assert.match(result.stdout, /Implemented: scan, status, diff, evidence, context, review, ui, --help, --version/);
  assert.match(result.stdout, /analysis are unsupported/);
  assert.match(result.stdout, /Java declarations \(Java schema 1\.3\.0\)/u);
  assert.match(result.stdout, /ui --evidence.*read-only loopback viewer/u);
  const ui = run('ui', '--help'); assert.equal(ui.status, 0); assert.equal(ui.stderr, ''); assert.match(ui.stdout, /127\.0\.0\.1/u); assert.match(ui.stdout, /no Git collection, review writes or live refresh/u);
});

test('version matches package metadata with no diagnostics', () => {
  const result = run('--version');
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), manifest.version);
  assert.equal(result.stderr, '');
});

test('bare invocation outside Git asks for a repository instead of scanning folders', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'difflearn-outside-'));
  try {
    const result = spawnSync(process.execPath, [entrypoint], { cwd: root, encoding: 'utf8', timeout: 20000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))) });
    assert.ifError(result.error); assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /Run dr inside a Git repository/u); assert.doesNotMatch(result.stderr, /Usage:/u);
  } finally { assert.ok(path.relative(os.tmpdir(), root).startsWith('difflearn-outside-')); await rm(root, { recursive: true, force: true }); }
});

for (const command of ['unknown']) {
  test(`${command} cannot pretend collection succeeded`, () => {
    const result = run(command);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /not implemented/);
  });
}

test('unknown flags and extra positional arguments fail on stderr', () => {
  for (const args of [['--invalid'], ['scan', 'extra']]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /error \[ARGUMENT_INVALID\]/);
  }
});
