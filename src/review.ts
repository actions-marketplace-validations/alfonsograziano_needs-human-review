import { aggregate, type Aggregate, type RunOutcome } from './aggregate.ts';
import { isDocOrTest } from './globs.ts';
import { code } from './markdown.ts';
import type { Harness, HarnessResult } from './harness/types.ts';
import type { Config } from './inputs.ts';
import { integratorMessage, sliceMessage, unreadMessage, type PrMeta, type SliceSummary } from './prompt.ts';
import { describeUnread, unreadParts, type Unread } from './reading.ts';
import type { FileRead, GateResult } from './types.ts';
import { parseVerdict } from './verdict.ts';
import { MAX_LINE_CHARS, type Workspace } from './workspace.ts';

export interface RunLog {
  label: string;
  ok: boolean;
  error?: string;
  durationMs?: number;
  costUsd?: number;
  reads?: number;
  /** Messages sent to this reviewer: 1, plus one per reminder about unread lines. */
  turns?: number;
  finalText?: string;
  raw?: string;
}

/**
 * How many times a reviewer that answered before reading everything is told
 * exactly which lines it skipped and asked to read them and answer again.
 */
export const READ_REMINDERS = 2;
/** A reminder is only sent with at least this much of the run's time left. */
const REMINDER_MIN_MS = 60_000;

/** A check's result: the outcome, or the lines the reviewer still has to read. */
type Checked = RunOutcome | { label: string; ok: false; error: string; unread: Unread[] };

export interface ReviewResult {
  aggregate: Aggregate;
  runs: RunLog[];
  /** Set when the AI step did not run at all, with the reason. */
  skipped?: string;
  costUsd: number;
}

export interface ReviewOptions {
  ws: Workspace;
  harness: Harness;
  systemPrompt: string;
  pr: PrMeta;
  gates: GateResult[];
  config: Config;
  log?: (line: string) => void;
}

/** The raw logs of every turn, one after the other. */
function joinRaw(before: string | undefined, raw: string, reminders: number): string {
  return reminders === 0 ? raw : `${before ?? ''}\n--- reminder ${reminders}: unread lines ---\n${raw}`;
}

function humanOnly(reason: string): Aggregate {
  return { decision: 'needs_human', risk: null, confidence: null, summary: reason, reasons: [reason], riskAreas: [], affectedCode: [], failures: [], rejected: [] };
}

/**
 * Runs one reviewer per slice, then the integrator when there is more than
 * one slice, and adds the verdicts up in code. Stops launching new slices as
 * soon as one says "needs_human", since the answer can no longer be "safe".
 */
export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  const { ws, harness, config, pr, gates } = opts;
  const log = opts.log ?? (() => undefined);
  const total = ws.slices.length;

  if (total === 0) {
    return { aggregate: humanOnly('The PR has no file the AI can review, so a human must check it.'), runs: [], skipped: 'no reviewable files', costUsd: 0 };
  }
  if (ws.longLines.length > 0) {
    const shown = ws.longLines.slice(0, 10).map(code).join(', ');
    return {
      aggregate: humanOnly(`Some changed lines are longer than ${MAX_LINE_CHARS} characters, so the reviewer could not read them in full: ${shown}${ws.longLines.length > 10 ? ', …' : ''}.`),
      runs: [],
      skipped: 'long lines',
      costUsd: 0,
    };
  }
  if (config.maxSlices > 0 && total > config.maxSlices) {
    return { aggregate: humanOnly(`Too big to review within the cost limit: ${total} slices, the limit is ${config.maxSlices}.`), runs: [], skipped: 'max-slices', costUsd: 0 };
  }

  const deadline = Date.now() + config.timeoutMinutes * 60_000;
  const outcomes: RunOutcome[] = [];
  const logs: RunLog[] = [];
  let stop = false;

  /**
   * One reviewer: one conversation with the harness. When the check finds
   * lines the reviewer never read, it gets a fixed message naming them and
   * answers again, up to READ_REMINDERS times, within the same time limit.
   * Reads add up across the conversation.
   */
  const runOne = async (label: string, userMessage: string, check: (r: HarnessResult, reads: FileRead[], reminders: number) => Checked): Promise<RunOutcome> => {
    if (Date.now() >= deadline) return { label, ok: false, error: `the AI step ran out of time (${config.timeoutMinutes} minutes)` };
    log(`${label}: reviewing`);
    const until = Math.min(deadline, Date.now() + config.sliceTimeoutMinutes * 60_000);
    const session = harness.open({ systemPrompt: opts.systemPrompt, workdir: ws.repoDir, model: config.model });
    const entry: RunLog & { durationMs: number; costUsd: number } = { label, ok: false, durationMs: 0, costUsd: 0, reads: 0, turns: 0, raw: '' };
    logs.push(entry);
    const reads: FileRead[] = [];
    let message = userMessage;
    try {
      for (let reminders = 0; ; reminders++) {
        let result: HarnessResult;
        try {
          entry.turns = reminders + 1;
          result = await session.send(message, Math.max(1_000, until - Date.now()));
        } catch (e) {
          const error = (e as Error).message;
          Object.assign(entry, { ok: false, error, raw: joinRaw(entry.raw, (e as { raw?: string }).raw ?? '', reminders) });
          log(`${label}: failed, ${error}`);
          return { label, ok: false, error };
        }
        reads.push(...result.reads);
        entry.durationMs += result.durationMs;
        entry.costUsd += result.costUsd ?? 0;
        Object.assign(entry, { reads: reads.length, finalText: result.finalText, raw: joinRaw(entry.raw, result.raw, reminders) });
        const checked = check(result, reads, reminders);
        if (!checked.ok && 'unread' in checked && reminders < READ_REMINDERS && until - Date.now() >= REMINDER_MIN_MS) {
          log(`${label}: answered before reading ${checked.unread.map(describeUnread).join(', ')}; asking it to read them`);
          message = unreadMessage(checked.unread);
          continue;
        }
        const outcome: RunOutcome = checked.ok ? checked : { label, ok: false, error: checked.error, rejected: true };
        Object.assign(entry, { ok: outcome.ok }, outcome.ok ? {} : { error: outcome.error });
        log(`${label}: ${outcome.ok ? `${outcome.verdict.decision}, risk ${outcome.verdict.risk}, ${outcome.verdict.confidence}/5` : `invalid, ${outcome.error}`}`);
        return outcome;
      }
    } finally {
      await session.close().catch(() => undefined);
    }
  };

  const sliceTask = async (index: number): Promise<void> => {
    const slice = ws.slices[index];
    if (!slice || stop) return;
    const label = total === 1 ? 'review' : `slice ${slice.index}`;
    const files = [...new Set(slice.items.map((i) => i.path))];
    const outcome = await runOne(label, sliceMessage(pr, gates, ws.reviewDir, slice.index, total), (r, reads, reminders) => {
      // Reading comes first: an answer given before reading is not judged, the reviewer is sent back to read.
      const unread = unreadParts(slice.items.flatMap((i) => i.mustRead), reads);
      if (unread.length > 0) {
        const after = reminders > 0 ? `after ${reminders} reminder${reminders > 1 ? 's' : ''}, ` : '';
        return { label, ok: false, error: `${after}the tool-call log shows these were not read: ${unread.map(describeUnread).join(', ')}`, unread };
      }
      const parsed = parseVerdict(r.finalText, { role: 'slice', sliceFiles: files, runtimeChanged: files.some((f) => !isDocOrTest(f)) });
      if (!parsed.ok) return { label, ok: false, error: parsed.error };
      return { label, ok: true, verdict: parsed.verdict };
    });
    outcomes[index] = outcome;
    if (!outcome.ok || outcome.verdict.decision === 'needs_human') stop = true;
  };

  let next = 0;
  const workers = Array.from({ length: Math.min(config.maxParallel, total) }, async () => {
    while (next < total && !stop) await sliceTask(next++);
  });
  await Promise.all(workers);
  const done = outcomes.filter(Boolean);
  if (done.length < total) log(`stopped after ${done.length} of ${total} slices: the answer is already "needs a human"`);

  if (total > 1 && !stop) {
    const summaries: SliceSummary[] = ws.slices.map((s, i) => {
      const o = outcomes[i];
      return { slice: s.index, files: [...new Set(s.items.map((x) => x.path))], verdict: o?.ok ? JSON.stringify(o.verdict, null, 2) : 'missing' };
    });
    const runtime = ws.files.some((f) => !isDocOrTest(f.path));
    done.push(
      await runOne('integrator', integratorMessage(pr, gates, ws.reviewDir, summaries), (r) => {
        const parsed = parseVerdict(r.finalText, { role: 'integrator', sliceFiles: [], runtimeChanged: runtime });
        return parsed.ok ? { label: 'integrator', ok: true, verdict: parsed.verdict } : { label: 'integrator', ok: false, error: parsed.error };
      }),
    );
  }

  const costUsd = logs.reduce((sum, l) => sum + (l.costUsd ?? 0), 0);
  return { aggregate: aggregate(done), runs: logs, costUsd };
}
