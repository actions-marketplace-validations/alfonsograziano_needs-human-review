import type { CheckState } from './gates.ts';
import type { MergeMethod } from './types.ts';

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export interface PullRequest {
  number: number;
  state: string;
  draft: boolean;
  title: string;
  body: string | null;
  user: { login: string; type: string };
  labels: { name: string }[];
  base: { ref: string; sha: string; repo: { full_name: string } };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
}

/** A small REST client on fetch. Only what the action needs. */
export class GitHub {
  readonly #token: string;
  readonly #api: string;
  readonly repo: string;

  constructor(token: string, repo: string, api = 'https://api.github.com') {
    this.#token = token;
    this.repo = repo;
    this.#api = api.replace(/\/$/, '');
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.#api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ai-risk-scorer',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // keep the raw text
      }
      throw new GitHubError(res.status, `${method} ${path}: ${res.status} ${message}`);
    }
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  /** Follows pages of a list endpoint. `pick` gets the array out of each page. */
  async paginate<T, P = T[]>(path: string, pick: (page: P) => T[], max = 10): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= max; page++) {
      const items = pick(await this.request<P>('GET', `${path}${sep}per_page=100&page=${page}`));
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  getPull(n: number): Promise<PullRequest> {
    return this.request('GET', `/repos/${this.repo}/pulls/${n}`);
  }

  pullsForCommit(sha: string): Promise<PullRequest[]> {
    return this.request('GET', `/repos/${this.repo}/commits/${sha}/pulls`);
  }

  async checkSuiteOfRun(runId: string): Promise<number | undefined> {
    const run = await this.request<{ check_suite_id?: number }>('GET', `/repos/${this.repo}/actions/runs/${runId}`);
    return run.check_suite_id;
  }

  /** Check runs and commit statuses on a commit, as one list. Our own are left out by the caller. */
  async checksFor(sha: string, skipSuite: number | undefined, skipContexts: string[]): Promise<CheckState[]> {
    type Run = { name: string; status: CheckState['status']; conclusion: string | null; check_suite?: { id: number } };
    const runs = await this.paginate<Run, { check_runs: Run[] }>(`/repos/${this.repo}/commits/${sha}/check-runs`, (p) => p.check_runs);
    const combined = await this.request<{ statuses: { context: string; state: string }[] }>('GET', `/repos/${this.repo}/commits/${sha}/status`);
    const checks: CheckState[] = runs
      .filter((r) => skipSuite === undefined || r.check_suite?.id !== skipSuite)
      .map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
    for (const s of combined.statuses) {
      if (skipContexts.includes(s.context)) continue;
      checks.push(s.state === 'pending' ? { name: s.context, status: 'pending', conclusion: null } : { name: s.context, status: 'completed', conclusion: s.state });
    }
    return checks;
  }

  /** Creates or updates the one comment that carries the marker. */
  async upsertComment(n: number, marker: string, body: string): Promise<void> {
    const comments = await this.paginate<{ id: number; body?: string }>(`/repos/${this.repo}/issues/${n}/comments`, (p) => p);
    const mine = comments.find((c) => c.body?.includes(marker));
    if (mine) await this.request('PATCH', `/repos/${this.repo}/issues/comments/${mine.id}`, { body });
    else await this.request('POST', `/repos/${this.repo}/issues/${n}/comments`, { body });
  }

  async setLabel(n: number, add: string, remove: string[]): Promise<void> {
    await this.request('POST', `/repos/${this.repo}/issues/${n}/labels`, { labels: [add] });
    for (const r of remove) {
      await this.request('DELETE', `/repos/${this.repo}/issues/${n}/labels/${encodeURIComponent(r)}`).catch((e: unknown) => {
        if (!(e instanceof GitHubError && e.status === 404)) throw e;
      });
    }
  }

  async setStatus(sha: string, state: 'success' | 'failure' | 'pending', context: string, description: string): Promise<void> {
    await this.request('POST', `/repos/${this.repo}/statuses/${sha}`, { state, context, description: description.slice(0, 140) });
  }

  /** Merges only if the head is still `sha`. Never uses admin rights. */
  async merge(n: number, sha: string, method: MergeMethod, title: string): Promise<void> {
    await this.request('PUT', `/repos/${this.repo}/pulls/${n}/merge`, { sha, merge_method: method, commit_title: `${title} (#${n})` });
  }
}
