import type { FileRead, ReadRequirement } from './types.ts';

type Range = [number, number];

function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** The parts of from..to that no range covers, in order. */
function gaps(ranges: Range[], from: number, to: number): Range[] {
  const out: Range[] = [];
  let next = from;
  for (const [a, b] of merge(ranges)) {
    if (b < next) continue;
    if (a > to) break;
    if (a > next) out.push([next, a - 1]);
    next = Math.max(next, b + 1);
    if (next > to) break;
  }
  if (next <= to) out.push([next, to]);
  return out;
}

/** A requirement the agent did not meet, with the exact lines it never read. */
export interface Unread {
  requirement: ReadRequirement;
  /** True when the tool-call log shows no read of this path at all. */
  neverOpened: boolean;
  ranges: Range[];
}

/**
 * Proof of reading. Returns what the agent did not read, judged only from the
 * harness's tool-call log, never from what the model says. A read with no
 * range means the whole file was returned.
 */
export function unreadParts(required: ReadRequirement[], reads: FileRead[]): Unread[] {
  const byPath = new Map<string, Range[]>();
  for (const r of reads) {
    const range: Range = [r.fromLine ?? 1, r.toLine ?? Number.MAX_SAFE_INTEGER];
    byPath.set(r.path, [...(byPath.get(r.path) ?? []), range]);
  }
  const out: Unread[] = [];
  for (const requirement of required) {
    if (requirement.totalLines === 0 && byPath.has(requirement.path)) continue;
    const from = requirement.fromLine ?? 1;
    const to = requirement.toLine ?? Math.max(1, requirement.totalLines);
    const ranges = gaps(byPath.get(requirement.path) ?? [], from, to);
    if (ranges.length > 0) out.push({ requirement, neverOpened: !byPath.has(requirement.path), ranges });
  }
  return out;
}

export function missingReads(required: ReadRequirement[], reads: FileRead[]): ReadRequirement[] {
  return unreadParts(required, reads).map((u) => u.requirement);
}

/** "a.ts (never opened)", "b.ts lines 121-279", "c.ts lines 5-9 and 40-41". */
export function describeUnread(u: Unread): string {
  if (u.neverOpened) return `${u.requirement.path} (never opened)`;
  const parts = u.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `${u.requirement.path} lines ${list}`;
}
