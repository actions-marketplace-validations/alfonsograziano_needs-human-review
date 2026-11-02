import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveContext, type WorkflowRunEvent } from '../src/context.ts';
import type { GitHub, PullRequest } from '../src/github.ts';

function pull(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 5,
    state: 'open',
    draft: false,
    title: 'Fix',
    body: 'b',
    user: { login: 'dev', type: 'User' },
    labels: [],
    base: { ref: 'main', sha: 'base1', repo: { full_name: 'me/repo' } },
    head: { ref: 'fix', sha: 'head1', repo: { full_name: 'me/repo' } },
    ...overrides,
  };
}

function stub(pr: PullRequest): GitHub {
  return { getPull: async () => pr, pullsForCommit: async () => [pr] } as unknown as GitHub;
}

const event = (overrides: Partial<NonNullable<WorkflowRunEvent['workflow_run']>> = {}): WorkflowRunEvent => ({
  workflow_run: { event: 'pull_request', conclusion: 'success', head_sha: 'head1', pull_requests: [{ number: 5, head: { sha: 'head1' } }], ...overrides },
  repository: { default_branch: 'main', full_name: 'me/repo' },
});

test('finds the PR from the event', async () => {
  const ctx = await resolveContext(stub(pull()), 'workflow_run', event(), []);
  assert.ok('pr' in ctx && ctx.pr.number === 5 && !ctx.facts.isFork && ctx.baseSha === 'base1');
});

test('finds a fork PR by commit, and marks it as a fork', async () => {
  const fork = pull({ head: { ref: 'fix', sha: 'head1', repo: { full_name: 'stranger/repo' } } });
  const ctx = await resolveContext(stub(fork), 'workflow_run', event({ pull_requests: [] }), []);
  assert.ok('pr' in ctx && ctx.facts.isFork);
});

test('skips drafts, other base branches and stale runs', async () => {
  assert.ok('skip' in (await resolveContext(stub(pull({ draft: true })), 'workflow_run', event(), [])));
  assert.ok('skip' in (await resolveContext(stub(pull({ base: { ref: 'dev', sha: 'b', repo: { full_name: 'me/repo' } } })), 'workflow_run', event(), [])));
  const moved = pull({ head: { ref: 'fix', sha: 'head2', repo: { full_name: 'me/repo' } } });
  const ctx = await resolveContext(stub(moved), 'workflow_run', event({ pull_requests: [{ number: 5, head: { sha: 'head1' } }] }), []);
  assert.ok('skip' in ctx && ctx.skip.includes('stale'));
});

test('skips runs that did not come from a green PR build', async () => {
  assert.ok('skip' in (await resolveContext(stub(pull()), 'workflow_run', event({ event: 'push' }), [])));
  assert.ok('skip' in (await resolveContext(stub(pull()), 'workflow_run', event({ conclusion: 'failure' }), [])));
});

test('refuses any trigger other than workflow_run', async () => {
  await assert.rejects(resolveContext(stub(pull()), 'pull_request', event(), []), /only runs on the workflow_run event/);
});
