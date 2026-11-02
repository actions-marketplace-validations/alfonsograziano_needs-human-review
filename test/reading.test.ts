import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingReads } from '../src/reading.ts';

const whole = { path: 'a.ts', totalLines: 3000 };

test('a file never opened is missing', () => {
  assert.equal(missingReads([whole], [{ path: 'b.ts' }]).length, 1);
});

test('a read with no range covers the whole file', () => {
  assert.equal(missingReads([whole], [{ path: 'a.ts' }]).length, 0);
});

test('ranges are merged across several reads', () => {
  const reads = [
    { path: 'a.ts', fromLine: 1, toLine: 2000 },
    { path: 'a.ts', fromLine: 2001, toLine: 3000 },
  ];
  assert.equal(missingReads([whole], reads).length, 0);
});

test('a gap in the reads means the file was not read in full', () => {
  const reads = [
    { path: 'a.ts', fromLine: 1, toLine: 2000 },
    { path: 'a.ts', fromLine: 2100, toLine: 3000 },
  ];
  assert.equal(missingReads([whole], reads).length, 1);
});

test('a range requirement only needs that range', () => {
  const req = { path: 'a.ts', fromLine: 100, toLine: 200, totalLines: 3000 };
  assert.equal(missingReads([req], [{ path: 'a.ts', fromLine: 50, toLine: 250 }]).length, 0);
  assert.equal(missingReads([req], [{ path: 'a.ts', fromLine: 150, toLine: 250 }]).length, 1);
});
