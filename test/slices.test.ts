import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSlices, type ReviewFile } from '../src/slices.ts';

function rf(path: string, patchTokens: number, fileTokens = 0, hunks = 1): ReviewFile {
  return {
    path,
    patchFile: `.r/patches/${path}.patch`,
    patchLines: 20,
    patchTokens,
    fileTokens,
    totalLines: fileTokens > 0 ? 100 : 0,
    hunks: Array.from({ length: hunks }, (_, i) => ({ newStart: i * 100 + 1, newLines: 10, tokens: Math.floor(patchTokens / hunks), patchLines: 12 })),
  };
}

const allPaths = (slices: ReturnType<typeof makeSlices>) => slices.flatMap((s) => s.items.map((i) => i.path));

test('a small PR is one slice', () => {
  const slices = makeSlices([rf('b.ts', 100, 100), rf('a.ts', 100, 100)], 10_000);
  assert.equal(slices.length, 1);
  assert.deepEqual(allPaths(slices), ['a.ts', 'b.ts']);
});

test('the full file counts toward the budget and must be read', () => {
  const slices = makeSlices([rf('a.ts', 1_000, 5_000), rf('b.ts', 1_000, 5_000)], 10_000);
  assert.equal(slices.length, 2);
  const reads = slices[0]?.items[0]?.mustRead.map((r) => r.path);
  assert.deepEqual(reads, ['.r/patches/a.ts.patch', 'a.ts']);
});

test('a removed file only needs its patch read', () => {
  const [slice] = makeSlices([rf('gone.ts', 100, 0)], 10_000);
  assert.deepEqual(slice?.items[0]?.mustRead.map((r) => r.path), ['.r/patches/gone.ts.patch']);
});

test('a test file stays in the same slice as its source', () => {
  const files = [rf('src/date.ts', 4_000), rf('src/zeta.ts', 4_000), rf('test/date.test.ts', 4_000), rf('src/alpha.ts', 4_000)];
  const slices = makeSlices(files, 9_000);
  const withDate = slices.find((s) => s.items.some((i) => i.path === 'src/date.ts'));
  assert.ok(withDate?.items.some((i) => i.path === 'test/date.test.ts'));
});

test('every file is in exactly one slice when nothing is split', () => {
  const files = Array.from({ length: 30 }, (_, i) => rf(`src/f${String(i).padStart(2, '0')}.ts`, 1_500, 1_500));
  const slices = makeSlices(files, 10_000);
  const paths = allPaths(slices);
  assert.equal(paths.length, 30);
  assert.equal(new Set(paths).size, 30);
  assert.ok(slices.every((s) => s.tokens <= 10_000));
});

test('a huge file is split at hunks, and each part must read around its hunks', () => {
  const slices = makeSlices([rf('big.ts', 30_000, 30_000, 6)], 12_000);
  assert.ok(slices.length > 1);
  const parts = slices.flatMap((s) => s.items);
  assert.ok(parts.every((p) => p.path === 'big.ts' && p.part));
  const covered = parts.flatMap((p) => p.part?.hunks ?? []).sort();
  assert.deepEqual(covered, [0, 1, 2, 3, 4, 5]);
  const first = parts[0];
  assert.equal(first?.mustRead[0]?.path, '.r/patches/big.ts.patch.part1');
  assert.ok(first?.mustRead.slice(1).every((r) => r.path === 'big.ts' && r.fromLine !== undefined));
});
