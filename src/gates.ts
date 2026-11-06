import { GENERATED_DEFAULTS, isBinaryAsset, isLockfile, matchesAny, samePath, SELF_PROTECTED_PATHS } from './globs.ts';
import type { Config } from './inputs.ts';
import type { ChangedFile, GateId, GateResult } from './types.ts';

export interface PrFacts {
  isFork: boolean;
  labels: string[];
}

export interface GateReport {
  results: GateResult[];
  /** The first gate that failed, or undefined when every gate passed. */
  stoppedAt?: GateId;
}

/** Every name a file is known by. A rename counts under both names. */
function namesOf(file: ChangedFile): string[] {
  return file.previousPath ? [file.path, file.previousPath] : [file.path];
}

function label(f: ChangedFile): string {
  return f.previousPath ? `${f.previousPath} → ${f.path}` : f.path;
}

function touching(files: ChangedFile[], match: (name: string) => boolean): string[] {
  return files.filter((f) => namesOf(f).some(match)).map(label);
}

export function generatedGlobs(config: Pick<Config, 'generatedPaths' | 'generatedDefaults'>): string[] {
  return [...(config.generatedDefaults ? GENERATED_DEFAULTS : []), ...config.generatedPaths];
}

export function isGenerated(file: ChangedFile, globs: readonly string[]): boolean {
  return matchesAny(file.path, globs);
}

/**
 * The hard gates, G2 to G6. They never read PR text and never call a model.
 * All of them run so the report is complete, but the first failure decides.
 * `promptFiles` are the prompt files set in the config: they protect themselves.
 */
export function runHardGates(files: ChangedFile[], pr: PrFacts, config: Config, promptFiles: string[] = []): GateReport {
  const results: GateResult[] = [];

  results.push(
    pr.isFork && !config.allowForks
      ? { id: 'fork', status: 'fail', detail: 'The PR comes from a fork, and allow-forks is false.' }
      : { id: 'fork', status: 'pass', detail: pr.isFork ? 'Fork PR, allowed by allow-forks.' : 'Not a fork.' },
  );

  results.push(
    pr.labels.includes(config.skipLabel)
      ? { id: 'skip-label', status: 'fail', detail: `The PR has the label "${config.skipLabel}".` }
      : { id: 'skip-label', status: 'pass', detail: 'No skip label.' },
  );

  // Prompt files are exact paths, not globs: `prompt[v2].md` must protect that file.
  const selfGlobs = [...SELF_PROTECTED_PATHS, ...config.selfProtectedPaths];
  const selfHits = touching(files, (n) => matchesAny(n, selfGlobs) || promptFiles.some((p) => samePath(n, p)));
  results.push(
    selfHits.length > 0
      ? { id: 'self-protected', status: 'fail', detail: 'Touches files that control this action.', files: selfHits }
      : { id: 'self-protected', status: 'pass', detail: 'No self-protected files.' },
  );

  // Symlinks can lead the reviewer out of the checkout, submodules point at
  // code the reviewer cannot see, and other binaries cannot be read at all.
  const special = files
    .map((f) => (f.special ? `${label(f)} (${f.special})` : f.binary && !isBinaryAsset(f.path) ? `${label(f)} (binary)` : undefined))
    .filter((x): x is string => x !== undefined);
  results.push(
    special.length > 0
      ? { id: 'special-files', status: 'fail', detail: 'Changes a symlink, a submodule or a binary file the reviewer cannot read.', files: special }
      : { id: 'special-files', status: 'pass', detail: 'No symlinks, submodules or unreadable binaries.' },
  );

  const locks = touching(files, isLockfile);
  results.push(
    locks.length > 0
      ? { id: 'lockfiles', status: 'fail', detail: 'Changes a dependency lock file.', files: locks }
      : { id: 'lockfiles', status: 'pass', detail: 'No lock files.' },
  );

  if (config.protectedPaths.length === 0) {
    results.push({ id: 'protected-paths', status: 'off', detail: 'No protected paths set.' });
  } else {
    const hits = touching(files, (n) => matchesAny(n, config.protectedPaths));
    results.push(
      hits.length > 0
        ? { id: 'protected-paths', status: 'fail', detail: 'Touches protected paths.', files: hits }
        : { id: 'protected-paths', status: 'pass', detail: 'No protected paths.' },
    );
  }

  results.push(sizeGate(files, config));

  const stoppedAt = results.find((r) => r.status === 'fail')?.id;
  return stoppedAt ? { results, stoppedAt } : { results };
}

function sizeGate(files: ChangedFile[], config: Config): GateResult {
  if (config.maxLinesChanged === 0 && config.maxFilesChanged === 0) {
    return { id: 'size', status: 'off', detail: 'Size check off.' };
  }
  // Only a generated file that already existed leaves the count. The PR picks
  // names, so a new file, or one renamed into dist/, counts like any other.
  const generated = generatedGlobs(config);
  const exempt = (f: ChangedFile) => (f.status === 'modified' || f.status === 'removed') && isGenerated(f, generated);
  const counted = files.filter((f) => !exempt(f));
  const lines = counted.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const problems: string[] = [];
  if (config.maxLinesChanged > 0 && lines > config.maxLinesChanged) {
    problems.push(`${lines} lines changed, the limit is ${config.maxLinesChanged}`);
  }
  if (config.maxFilesChanged > 0 && counted.length > config.maxFilesChanged) {
    problems.push(`${counted.length} files changed, the limit is ${config.maxFilesChanged}`);
  }
  const ignored = files.length - counted.length;
  const note = ignored > 0 ? ` (${ignored} generated files not counted)` : '';
  return problems.length > 0
    ? { id: 'size', status: 'fail', detail: `Too big: ${problems.join('; ')}${note}.` }
    : { id: 'size', status: 'pass', detail: `${lines} lines in ${counted.length} files${note}.` };
}

export interface CheckState {
  name: string;
  /** For check runs: queued, in_progress, completed. Statuses map pending to in_progress. */
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion: string | null;
}

export type CiState = { state: 'green' } | { state: 'pending'; names: string[] } | { state: 'failed'; names: string[] } | { state: 'missing'; names: string[] };

const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Polls until CI is no longer pending, or the wait runs out. Checks from
 * GitHub Apps (security scanners, for example) do not start a workflow_run
 * when they finish, so the action has to wait for them itself.
 */
export async function waitForCi(
  read: () => Promise<CiState>,
  waitMs: number,
  pollMs = 20_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<CiState> {
  let state = await read();
  for (let tries = Math.floor(waitMs / pollMs); state.state === 'pending' && tries > 0; tries--) {
    await sleep(pollMs);
    state = await read();
  }
  return state;
}

/** G1: every other check on the head SHA must be green. The scorer's own check is ignored. */
export function ciState(checks: CheckState[], ownNames: string[], required: string[]): CiState {
  const others = checks.filter((c) => !ownNames.includes(c.name));
  const missing = required.filter((r) => !others.some((c) => c.name === r));
  const pending = others.filter((c) => c.status !== 'completed').map((c) => c.name);
  const failed = others.filter((c) => c.status === 'completed' && !OK_CONCLUSIONS.has(c.conclusion ?? '')).map((c) => c.name);
  if (failed.length > 0) return { state: 'failed', names: failed };
  if (pending.length > 0) return { state: 'pending', names: pending };
  if (missing.length > 0) return { state: 'missing', names: missing };
  return { state: 'green' };
}
