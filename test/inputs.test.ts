import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, parseList, readConfig } from '../src/inputs.ts';

test('defaults are the safe ones', () => {
  const c = readConfig({});
  assert.equal(c.mode, 'shadow');
  assert.equal(c.maxLinesChanged, 0);
  assert.equal(c.maxFilesChanged, 0);
  assert.equal(c.maxRiskToMerge, 'low');
  assert.equal(c.minConfidence, 4);
  assert.equal(c.allowForks, false);
  assert.equal(c.generatedDefaults, true);
});

test('inputs are read from INPUT_ variables', () => {
  const c = readConfig({
    INPUT_MODE: 'autonomous',
    INPUT_PROTECTED_PATHS: 'payments/**\n# a comment\n\n*.tf\n',
    INPUT_MAX_LINES_CHANGED: '400',
    INPUT_MIN_CONFIDENCE: '5',
  });
  assert.equal(c.mode, 'autonomous');
  assert.deepEqual(c.protectedPaths, ['payments/**', '*.tf']);
  assert.equal(c.maxLinesChanged, 400);
  assert.equal(c.minConfidence, 5);
});

test('lists are split by line, so globs with commas survive', () => {
  assert.deepEqual(parseList('src/{a,b}/**\n  x  '), ['src/{a,b}/**', 'x']);
});

test('bad config is rejected with every problem listed', () => {
  assert.throws(
    () =>
      readConfig({
        INPUT_MODE: 'yolo',
        INPUT_MIN_CONFIDENCE: '0.7',
        INPUT_SYSTEM_PROMPT: 'a',
        INPUT_SYSTEM_PROMPT_FILE: 'b.md',
        INPUT_MAX_RISK_TO_MERGE: 'high',
      }),
    (e: unknown) => e instanceof ConfigError && e.problems.length === 4,
  );
});
