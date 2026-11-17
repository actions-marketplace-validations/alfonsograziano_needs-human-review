import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeUnread, missingReads, unreadParts } from '../src/reading.ts';

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

test('unreadParts names the exact lines that were never read', () => {
  // The PR 31 case: a 786-line file read as 1-120, 280-479 and 480-799.
  const reads = [
    { path: 'lib/talks-schedule.js', fromLine: 1, toLine: 120 },
    { path: 'lib/talks-schedule.js', fromLine: 280, toLine: 479 },
    { path: 'lib/talks-schedule.js', fromLine: 480, toLine: 799 },
  ];
  const [u] = unreadParts([{ path: 'lib/talks-schedule.js', totalLines: 786 }], reads);
  assert.deepEqual(u?.ranges, [[121, 279]]);
  assert.equal(u && describeUnread(u), 'lib/talks-schedule.js lines 121-279');
});

test('unreadParts lists every gap, and says when a file was never opened', () => {
  const reads = [
    { path: 'a.ts', fromLine: 1, toLine: 10 },
    { path: 'a.ts', fromLine: 20, toLine: 29 },
  ];
  const [a, b] = unreadParts([{ path: 'a.ts', totalLines: 31 }, { path: 'b.ts', totalLines: 5 }], reads);
  assert.equal(a && describeUnread(a), 'a.ts lines 11-19 and 30-31');
  assert.equal(b && describeUnread(b), 'b.ts (never opened)');
});

test('an empty file counts as read once it was opened', () => {
  assert.deepEqual(unreadParts([{ path: 'e.ts', totalLines: 0 }], [{ path: 'e.ts', fromLine: 1, toLine: 0 }]), []);
  assert.equal(unreadParts([{ path: 'e.ts', totalLines: 0 }], []).length, 1);
});
