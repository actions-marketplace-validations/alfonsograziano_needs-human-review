import { RISK_ORDER, type AffectedCode, type Risk, type Verdict } from './types.ts';

/** The outcome of one reviewer run: a slice, or the integrator. */
export type RunOutcome = { label: string; ok: true; verdict: Verdict } | { label: string; ok: false; error: string };

export interface Aggregate {
  decision: 'safe' | 'needs_human';
  /** Null when no run gave a valid verdict. */
  risk: Risk | null;
  confidence: number | null;
  summary: string;
  reasons: string[];
  riskAreas: string[];
  affectedCode: AffectedCode[];
  failures: string[];
}

/**
 * Adds up the runs. One "needs_human" is enough, the highest risk wins, the
 * lowest confidence wins, and any failed run means a human must check.
 */
export function aggregate(runs: RunOutcome[]): Aggregate {
  const good = runs.filter((r): r is Extract<RunOutcome, { ok: true }> => r.ok);
  const failures = runs.filter((r): r is Extract<RunOutcome, { ok: false }> => !r.ok).map((r) => `${r.label}: ${r.error}`);
  const many = runs.length > 1;
  const tag = (label: string, text: string) => (many ? `[${label}] ${text}` : text);

  let risk: Risk | null = null;
  for (const r of good) if (risk === null || RISK_ORDER[r.verdict.risk] > RISK_ORDER[risk]) risk = r.verdict.risk;
  const confidence = good.length > 0 ? Math.min(...good.map((r) => r.verdict.confidence)) : null;
  const anyNo = good.some((r) => r.verdict.decision === 'needs_human');

  const blockers = good.filter((r) => r.verdict.decision === 'needs_human');
  const reasonSource = blockers.length > 0 ? blockers : good;
  const reasons = reasonSource.flatMap((r) => r.verdict.reasons.map((x) => tag(r.label, x)));

  const integrator = good.find((r) => r.label === 'integrator');
  const summary = (integrator ?? good[0])?.verdict.summary ?? 'The review could not finish.';

  return {
    decision: failures.length === 0 && !anyNo && good.length > 0 ? 'safe' : 'needs_human',
    risk,
    confidence,
    summary,
    reasons,
    riskAreas: [...new Set(good.flatMap((r) => r.verdict.risk_areas))],
    affectedCode: good.flatMap((r) => r.verdict.affected_code.map((a) => ({ location: a.location, why: tag(r.label, a.why) }))),
    failures,
  };
}
