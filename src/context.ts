import type { PrFacts } from './gates.ts';
import type { GitHub, PullRequest } from './github.ts';
import type { PrMeta } from './prompt.ts';

/** The parts of a workflow_run event the action reads. */
export interface WorkflowRunEvent {
  workflow_run?: {
    event: string;
    conclusion: string | null;
    head_sha: string;
    pull_requests?: { number: number; head: { sha: string } }[];
  };
  repository?: { default_branch: string; full_name: string };
}

export type Context =
  | { skip: string }
  | { pr: PullRequest; meta: PrMeta; facts: PrFacts; baseSha: string; headSha: string; allowedBases: string[] };

/**
 * G0. Finds the PR for the finished workflow run and checks that it is open,
 * not a draft, on an allowed base branch, and still at the tested commit.
 * Any "no" means there is nothing to judge, so the action exits quietly.
 */
export async function resolveContext(gh: GitHub, eventName: string, event: WorkflowRunEvent, baseBranches: string[]): Promise<Context> {
  if (eventName !== 'workflow_run' || !event.workflow_run) {
    throw new Error(`Needs Human Review only runs on the workflow_run event, got "${eventName}". See the README for why.`);
  }
  const run = event.workflow_run;
  if (run.event !== 'pull_request') return { skip: `the workflow run came from "${run.event}", not a pull request` };
  if (run.conclusion !== 'success') return { skip: `the workflow run concluded "${run.conclusion}"` };

  const headSha = run.head_sha;
  let numbers = (run.pull_requests ?? []).filter((p) => p.head.sha === headSha).map((p) => p.number);
  if (numbers.length === 0) {
    // Fork PRs are not listed on the event. Look them up by commit.
    numbers = (await gh.pullsForCommit(headSha)).filter((p) => p.state === 'open' && p.head.sha === headSha).map((p) => p.number);
  }
  if (numbers.length === 0) return { skip: `no open PR has head ${headSha}` };
  if (numbers.length > 1) return { skip: `more than one PR has head ${headSha}: ${numbers.join(', ')}` };

  const pr = await gh.getPull(numbers[0] as number);
  const allowed = baseBranches.length > 0 ? baseBranches : [event.repository?.default_branch ?? 'main'];
  if (pr.state !== 'open') return { skip: `PR #${pr.number} is ${pr.state}` };
  if (pr.draft) return { skip: `PR #${pr.number} is a draft` };
  if (!allowed.includes(pr.base.ref)) return { skip: `PR #${pr.number} targets ${pr.base.ref}, not ${allowed.join(' or ')}` };
  if (pr.head.sha !== headSha) return { skip: `PR #${pr.number} moved on to ${pr.head.sha}; this run is stale` };

  const isFork = pr.head.repo === null || pr.head.repo.full_name !== pr.base.repo.full_name;
  return {
    pr,
    headSha,
    baseSha: pr.base.sha,
    allowedBases: allowed,
    facts: { isFork, labels: pr.labels.map((l) => l.name) },
    meta: {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      author: pr.user.login,
      authorIsBot: pr.user.type === 'Bot',
      baseRef: pr.base.ref,
      headSha,
    },
  };
}

/**
 * What changed on the PR since it was scored, that would have stopped the run.
 * Called right before acting, because a review takes minutes and the merge
 * call only pins the head commit. Empty means nothing that matters changed.
 */
export function changesSinceScored(scored: PullRequest, now: PullRequest, allowedBases: string[], skipLabel: string): string[] {
  const changes: string[] = [];
  if (now.state !== 'open') changes.push(`it is now ${now.state}`);
  if (now.draft) changes.push('it is now a draft');
  if (now.head.sha !== scored.head.sha) changes.push(`its head moved to ${now.head.sha.slice(0, 7)}`);
  if (now.base.ref !== scored.base.ref) changes.push(`its base branch changed from ${scored.base.ref} to ${now.base.ref}`);
  else if (!allowedBases.includes(now.base.ref)) changes.push(`its base branch ${now.base.ref} is not allowed`);
  if (now.labels.some((l) => l.name === skipLabel)) changes.push(`it has the label "${skipLabel}"`);
  return changes;
}
