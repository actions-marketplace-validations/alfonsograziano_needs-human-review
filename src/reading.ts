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

function covers(ranges: Range[], from: number, to: number): boolean {
  return merge(ranges).some(([a, b]) => a <= from && b >= to);
}

/**
 * Proof of reading. Returns the requirements the agent did not meet, judged
 * only from the harness's tool-call log, never from what the model says.
 * A read with no range means the whole file was returned.
 */
export function missingReads(required: ReadRequirement[], reads: FileRead[]): ReadRequirement[] {
  const byPath = new Map<string, Range[]>();
  for (const r of reads) {
    const range: Range = [r.fromLine ?? 1, r.toLine ?? Number.MAX_SAFE_INTEGER];
    byPath.set(r.path, [...(byPath.get(r.path) ?? []), range]);
  }
  return required.filter((req) => {
    const ranges = byPath.get(req.path);
    if (!ranges) return true;
    if (req.totalLines === 0) return false;
    const from = req.fromLine ?? 1;
    const to = req.toLine ?? req.totalLines;
    return !covers(ranges, from, to);
  });
}

export function describeRequirement(r: ReadRequirement): string {
  return r.fromLine || r.toLine ? `${r.path} lines ${r.fromLine ?? 1}-${r.toLine ?? r.totalLines}` : r.path;
}
