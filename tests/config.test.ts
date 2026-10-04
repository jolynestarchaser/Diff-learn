import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/config/load.js';
import { defaultLimits, resolveLimits } from '../src/config/schema.js';

test('config rejects unknown/version/duplicate/traversal/limit errors', () => {
  for (const text of [
    '{"configVersion":"2"}', '{"configVersion":"1","unknown":true}',
    '{"configVersion":"1","base":"a","b\\u0061se":"b"}',
    '{"configVersion":"1","limits":{"maxDepth":1,"maxDepth":2}}',
    '{"configVersion":"1","repositories":[{"path":"../outside"}]}',
    '{"configVersion":"1","repositories":[{"path":"a","key":"same"},{"path":"b","key":"same"}]}',
    '{"configVersion":"1","excludePaths":["."]}',
    '{"configVersion":"1","limits":{"concurrency":0}}', '[]', '{',
  ]) assert.throws(() => parseConfig(text));
});

test('config keeps literal data and fills only absent limits', () => {
  const config = parseConfig('{"configVersion":"1","base":"origin/main","limits":{"maxDepth":0},"repositories":[{"path":"hello world/ไทย"}]}');
  assert.equal(config.base, 'origin/main');
  assert.equal(resolveLimits(config.limits).maxDepth, 0);
  assert.equal(resolveLimits(config.limits).maxDirectories, defaultLimits.maxDirectories);
});
