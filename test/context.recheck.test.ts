import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changesSinceScored } from '../src/context.ts';
import type { PullRequest } from '../src/github.ts';

const pr: PullRequest = {
  number: 1,
  state: 'open',
  draft: false,
  title: 't',
  body: null,
  user: { login: 'dev', type: 'User' },
  labels: [],
  base: { ref: 'main', sha: 'b1', repo: { full_name: 'o/r' } },
  head: { ref: 'f', sha: 'h1', repo: { full_name: 'o/r' } },
};

test('nothing that matters changed: no blockers, even if the base branch moved on', () => {
  assert.deepEqual(changesSinceScored(pr, { ...pr, base: { ...pr.base, sha: 'b2' } }, ['main'], 'skip'), []);
});

test('a skip label, a new base branch, a new head or a closed PR block the merge', () => {
  const now: PullRequest = { ...pr, state: 'closed', draft: true, labels: [{ name: 'skip' }], base: { ...pr.base, ref: 'release' }, head: { ...pr.head, sha: 'h2' } };
  const changes = changesSinceScored(pr, now, ['main'], 'skip');
  assert.equal(changes.length, 5);
  assert.ok(changes.some((c) => c.includes('release')));
  assert.ok(changes.some((c) => c.includes('"skip"')));
});
