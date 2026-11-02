import { isTestFile } from './globs.ts';
import type { ReadRequirement } from './types.ts';

export interface Hunk {
  /** First line of the hunk in the new file (1-based). */
  newStart: number;
  newLines: number;
  tokens: number;
  /** Lines of patch text in this hunk, header included. */
  patchLines: number;
}

/** A changed file, measured, ready to be packed. Generated files are not passed in. */
export interface ReviewFile {
  path: string;
  /** Path of the patch file, relative to the workdir. */
  patchFile: string;
  patchLines: number;
  patchTokens: number;
  /** Tokens of the full new version. 0 when the file was removed or is binary. */
  fileTokens: number;
  /** Lines in the full new version. 0 when the file was removed or is binary. */
  totalLines: number;
  hunks: Hunk[];
}

export interface SliceItem {
  path: string;
  /** Set when a file was too big and was split at hunk boundaries. */
  part?: { index: number; total: number; hunks: number[]; patchFile: string };
  mustRead: ReadRequirement[];
}

export interface Slice {
  index: number;
  items: SliceItem[];
  tokens: number;
}

/** Lines read around each hunk when a file is split into parts. */
export const PART_CONTEXT_LINES = 40;

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function cost(f: ReviewFile): number {
  return f.patchTokens + f.fileTokens;
}

function wholeFileReads(f: ReviewFile): ReadRequirement[] {
  const reads: ReadRequirement[] = [{ path: f.patchFile, totalLines: f.patchLines }];
  if (f.totalLines > 0) reads.push({ path: f.path, totalLines: f.totalLines });
  return reads;
}

/** `foo.test.ts`, `foo.spec.js`, `foo_test.go`, `test_foo.py` → `foo`. */
function stem(path: string): string {
  let base = path.slice(path.lastIndexOf('/') + 1);
  base = base.replace(/^test_/, '');
  const dot = base.indexOf('.');
  if (dot > 0) base = base.slice(0, dot);
  return base.replace(/_test$/, '');
}

/** Groups each test file with the source file it tests, when the names match. */
function units(files: ReviewFile[]): ReviewFile[][] {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const sources = new Map<string, ReviewFile[]>();
  for (const f of sorted) {
    if (isTestFile(f.path)) continue;
    const key = stem(f.path);
    sources.set(key, [...(sources.get(key) ?? []), f]);
  }
  const groups = new Map<ReviewFile, ReviewFile[]>();
  const result: ReviewFile[][] = [];
  for (const f of sorted) {
    if (isTestFile(f.path)) {
      const candidates = sources.get(stem(f.path)) ?? [];
      // Prefer a source in the same folder tree, then the first one.
      const dir = f.path.slice(0, f.path.lastIndexOf('/') + 1);
      const owner = candidates.find((c) => c.path.startsWith(dir)) ?? candidates[0];
      if (owner) {
        groups.get(owner)?.push(f);
        continue;
      }
      result.push([f]);
      continue;
    }
    const group = [f];
    groups.set(f, group);
    result.push(group);
  }
  return result;
}

/** Splits one file that does not fit into parts, each a run of whole hunks. */
function splitFile(f: ReviewFile, budget: number): SliceItem[][] {
  const parts: number[][] = [];
  let current: number[] = [];
  let tokens = 0;
  const contextCost = (h: Hunk) => h.tokens + Math.ceil((h.newLines + 2 * PART_CONTEXT_LINES) * 12);
  f.hunks.forEach((h, i) => {
    const c = contextCost(h);
    if (current.length > 0 && tokens + c > budget) {
      parts.push(current);
      current = [];
      tokens = 0;
    }
    current.push(i);
    tokens += c;
  });
  if (current.length > 0) parts.push(current);
  return parts.map((hunks, i) => {
    const patchFile = `${f.patchFile}.part${i + 1}`;
    const patchLines = hunks.reduce((sum, h) => sum + (f.hunks[h]?.patchLines ?? 0), 0);
    const mustRead: ReadRequirement[] = [{ path: patchFile, totalLines: patchLines }];
    if (f.totalLines > 0) {
      for (const h of hunks) {
        const hunk = f.hunks[h];
        if (!hunk) continue;
        mustRead.push({
          path: f.path,
          fromLine: Math.max(1, hunk.newStart - PART_CONTEXT_LINES),
          toLine: Math.min(f.totalLines, hunk.newStart + hunk.newLines + PART_CONTEXT_LINES),
          totalLines: f.totalLines,
        });
      }
    }
    return [{ path: f.path, part: { index: i + 1, total: parts.length, hunks, patchFile }, mustRead }];
  });
}

/**
 * Packs files into slices that fit the budget. Files stay in path order, a test
 * stays with its source, and a file too big for one slice is split at hunks.
 * Every file ends up in at least one slice.
 */
export function makeSlices(files: ReviewFile[], budget: number): Slice[] {
  const slices: Slice[] = [];
  let current: SliceItem[] = [];
  let tokens = 0;

  const flush = () => {
    if (current.length > 0) slices.push({ index: slices.length + 1, items: current, tokens });
    current = [];
    tokens = 0;
  };

  for (const unit of units(files)) {
    const unitCost = unit.reduce((sum, f) => sum + cost(f), 0);
    const pieces: ReviewFile[][] = unitCost > budget && unit.length > 1 ? unit.map((f) => [f]) : [unit];
    for (const piece of pieces) {
      const pieceCost = piece.reduce((sum, f) => sum + cost(f), 0);
      const only = piece[0];
      if (piece.length === 1 && only && pieceCost > budget && only.hunks.length > 1) {
        flush();
        for (const part of splitFile(only, budget)) {
          slices.push({ index: slices.length + 1, items: part, tokens: Math.min(budget, pieceCost) });
        }
        continue;
      }
      if (current.length > 0 && tokens + pieceCost > budget) flush();
      for (const f of piece) current.push({ path: f.path, mustRead: wholeFileReads(f) });
      tokens += pieceCost;
    }
  }
  flush();
  return slices;
}
