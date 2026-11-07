import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciState, runHardGates, waitForCi, type CiState } from '../src/gates.ts';
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
  const r = runHardGates([file('a.ts')], { isFork: false, labels: ['needs-human-review:always'] }, testConfig());
  assert.equal(r.stoppedAt, 'skip-label');
});

test('workflow files and prompt files protect themselves', () => {
  assert.equal(runHardGates([file('.github/workflows/ci.yml')], noFork, testConfig()).stoppedAt, 'self-protected');
  const r = runHardGates([file('.github/scorer.md')], noFork, testConfig(), ['.github/scorer.md']);
  assert.equal(r.stoppedAt, 'self-protected');
  assert.equal(runHardGates([file('.needs-human-review-cafe/pr.json')], noFork, testConfig()).stoppedAt, 'self-protected');
});

test('protected paths match the old name of a renamed file', () => {
  const moved = file('utils/charge.ts', { status: 'renamed', previousPath: 'payments/charge.ts' });
  const r = runHardGates([moved], noFork, testConfig({ protectedPaths: ['payments/**'] }));
  assert.equal(r.stoppedAt, 'protected-paths');
  assert.deepEqual(r.results.find((g) => g.id === 'protected-paths')?.files, ['payments/charge.ts → utils/charge.ts']);
});

test('the size gate counts lines and files, without generated files', () => {
  const files = [file('src/a.ts', { additions: 30, deletions: 10 }), file('dist/app.min.js', { additions: 5000, deletions: 2000 })];
  assert.equal(runHardGates(files, noFork, testConfig({ maxLinesChanged: 50 })).stoppedAt, undefined);
  assert.equal(runHardGates(files, noFork, testConfig({ maxLinesChanged: 39 })).stoppedAt, 'size');
  assert.equal(runHardGates(files, noFork, testConfig({ maxFilesChanged: 1 })).stoppedAt, undefined);
  assert.equal(runHardGates(files, noFork, testConfig({ maxLinesChanged: 50, generatedDefaults: false })).stoppedAt, 'size');
});

test('a new or renamed-in generated file counts for size', () => {
  const added = [file('src/dist/helpers.js', { status: 'added', additions: 300, deletions: 0 })];
  assert.equal(runHardGates(added, noFork, testConfig({ maxLinesChanged: 50 })).stoppedAt, 'size');
  const moved = [file('src/dist/auth.js', { status: 'renamed', previousPath: 'src/auth.js', additions: 300, deletions: 0 })];
  assert.equal(runHardGates(moved, noFork, testConfig({ maxLinesChanged: 50 })).stoppedAt, 'size');
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

test('waitForCi polls a pending check until it finishes, or gives up', async () => {
  const states: CiState[] = [{ state: 'pending', names: ['GitGuardian'] }, { state: 'pending', names: ['GitGuardian'] }, { state: 'green' }];
  let reads = 0;
  const noSleep = async () => undefined;
  const done = await waitForCi(async () => states[Math.min(reads++, states.length - 1)] as CiState, 60_000, 20_000, noSleep);
  assert.deepEqual(done, { state: 'green' });
  assert.equal(reads, 3);

  let slow = 0;
  const stuck = await waitForCi(async () => (slow++, { state: 'pending', names: ['x'] }), 40_000, 20_000, noSleep);
  assert.equal(stuck.state, 'pending');
  assert.equal(slow, 3, 'one first read, then two polls in 40 seconds');
});

test('a lock file change always needs a human, at any depth', () => {
  const r = runHardGates([file('README.md'), file('web/package-lock.json')], noFork, testConfig());
  assert.equal(r.stoppedAt, 'lockfiles');
  assert.deepEqual(r.results.find((g) => g.id === 'lockfiles')?.files, ['web/package-lock.json']);
});

test('symlinks, submodules and unreadable binaries need a human; images do not', () => {
  const special = (f: Parameters<typeof file>[1]) => runHardGates([file('x', f)], noFork, testConfig()).stoppedAt;
  assert.equal(special({ special: 'symlink' }), 'special-files');
  assert.equal(special({ special: 'submodule' }), 'special-files');
  assert.equal(runHardGates([file('lib/addon.node', { binary: true })], noFork, testConfig()).stoppedAt, 'special-files');
  assert.equal(runHardGates([file('docs/logo.PNG', { binary: true })], noFork, testConfig()).stoppedAt, undefined);
});

test('.gitattributes at any depth is self-protected', () => {
  assert.equal(runHardGates([file('.gitattributes')], noFork, testConfig()).stoppedAt, 'self-protected');
  assert.equal(runHardGates([file('src/.gitattributes')], noFork, testConfig()).stoppedAt, 'self-protected');
});

test('prompt files are matched as exact paths, so glob characters cannot hide them', () => {
  const r = runHardGates([file('ai/prompt[v2].md')], noFork, testConfig(), ['./ai/prompt[v2].md']);
  assert.equal(r.stoppedAt, 'self-protected');
  assert.equal(runHardGates([file('ai/promptv.md')], noFork, testConfig(), ['ai/prompt[v2].md']).stoppedAt, undefined);
});

test('a protected folder written without a trailing slash protects its files', () => {
  const cfg = testConfig({ protectedPaths: ['src/payments', '**/migrations'] });
  assert.equal(runHardGates([file('src/payments/charge.ts')], noFork, cfg).stoppedAt, 'protected-paths');
  assert.equal(runHardGates([file('db/migrations/001.sql')], noFork, cfg).stoppedAt, 'protected-paths');
  assert.equal(runHardGates([file('migrations/001.sql')], noFork, cfg).stoppedAt, 'protected-paths');
  assert.equal(runHardGates([file('src/payments.ts')], noFork, cfg).stoppedAt, undefined);
});
