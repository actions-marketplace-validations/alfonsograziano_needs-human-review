import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciState, runHardGates } from '../src/gates.ts';
import { file, testConfig } from './helpers.ts';

const noFork = { isFork: false, labels: [] };

test('a plain PR passes every hard gate', () => {
  const r = runHardGates([file('src/a.ts')], noFork, testConfig());
  assert.equal(r.stoppedAt, undefined);
  assert.equal(r.results.find((g) => g.id === 'size')?.status, 'off');
});

test('fork PRs need a human unless allowed', () => {
  assert.equal(runHardGates([file('a.ts')], { isFork: true, labels: [] }, testConfig()).stoppedAt, 'fork');
  assert.equal(runHardGates([file('a.ts')], { isFork: true, labels: [] }, testConfig({ allowForks: true })).stoppedAt, undefined);
});

test('the skip label sends the PR to a human', () => {
  const r = runHardGates([file('a.ts')], { isFork: false, labels: ['ai-risk-scorer:skip'] }, testConfig());
  assert.equal(r.stoppedAt, 'skip-label');
});

test('workflow files and prompt files protect themselves', () => {
  assert.equal(runHardGates([file('.github/workflows/ci.yml')], noFork, testConfig()).stoppedAt, 'self-protected');
  const r = runHardGates([file('.github/scorer.md')], noFork, testConfig(), ['.github/scorer.md']);
  assert.equal(r.stoppedAt, 'self-protected');
});

test('protected paths match the old name of a renamed file', () => {
  const moved = file('utils/charge.ts', { status: 'renamed', previousPath: 'payments/charge.ts' });
  const r = runHardGates([moved], noFork, testConfig({ protectedPaths: ['payments/**'] }));
  assert.equal(r.stoppedAt, 'protected-paths');
  assert.deepEqual(r.results.find((g) => g.id === 'protected-paths')?.files, ['payments/charge.ts → utils/charge.ts']);
});

test('the size gate counts lines and files, without generated files', () => {
  const files = [file('src/a.ts', { additions: 30, deletions: 10 }), file('package-lock.json', { additions: 5000, deletions: 2000 })];
  assert.equal(runHardGates(files, noFork, testConfig({ maxLinesChanged: 50 })).stoppedAt, undefined);
  assert.equal(runHardGates(files, noFork, testConfig({ maxLinesChanged: 39 })).stoppedAt, 'size');
  assert.equal(runHardGates(files, noFork, testConfig({ maxFilesChanged: 1 })).stoppedAt, undefined);
  assert.equal(runHardGates(files, noFork, testConfig({ maxLinesChanged: 50, generatedDefaults: false })).stoppedAt, 'size');
});

test('the first failing gate is reported, but all gates run', () => {
  const r = runHardGates([file('.github/workflows/ci.yml')], { isFork: true, labels: [] }, testConfig());
  assert.equal(r.stoppedAt, 'fork');
  assert.equal(r.results.find((g) => g.id === 'self-protected')?.status, 'fail');
});

test('CI state ignores our own check and waits for running ones', () => {
  const done = (name: string, conclusion: string) => ({ name, status: 'completed' as const, conclusion });
  assert.deepEqual(ciState([done('test', 'success'), done('lint', 'skipped')], [], []), { state: 'green' });
  assert.equal(ciState([done('test', 'failure')], [], []).state, 'failed');
  assert.equal(ciState([{ name: 'test', status: 'in_progress', conclusion: null }], [], []).state, 'pending');
  assert.equal(ciState([{ name: 'score', status: 'in_progress', conclusion: null }], ['score'], []).state, 'green');
  assert.equal(ciState([done('lint', 'success')], [], ['test']).state, 'missing');
});
