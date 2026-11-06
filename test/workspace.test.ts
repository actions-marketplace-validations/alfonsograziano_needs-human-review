import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseFileReader, hasLongLine, listChanges, lockWorkspace, parseChanges, parsePatch, prepareWorkspace, unlockWorkspace } from '../src/workspace.ts';
import { tempRepo } from './repo.ts';
import { testConfig } from './helpers.ts';

test('parseChanges reads renames, binaries and counts', () => {
  const ns = 'M\0src/a.ts\0R090\0old/b.ts\0new/b.ts\0A\0img.png\0';
  const nm = '3\t1\tsrc/a.ts\0' + '2\t2\t\0old/b.ts\0new/b.ts\0' + '-\t-\timg.png\0';
  const files = parseChanges(ns, nm);
  assert.deepEqual(files, [
    { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, binary: false },
    { path: 'new/b.ts', previousPath: 'old/b.ts', status: 'renamed', additions: 2, deletions: 2, binary: false },
    { path: 'img.png', status: 'added', additions: 0, deletions: 0, binary: true },
  ]);
});

test('parsePatch finds hunks and their new line ranges', () => {
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,4 @@ fn\n a\n+b\n c\n@@ -20,2 +21,2 @@\n-d\n+e\n';
  const { header, hunks } = parsePatch(patch);
  assert.ok(header.startsWith('diff --git'));
  assert.equal(hunks.length, 2);
  assert.deepEqual([hunks[0]?.newStart, hunks[0]?.newLines, hunks[1]?.newStart], [1, 4, 21]);
});

test('prepareWorkspace writes patches, old versions, slices and pr.json', async () => {
  const repo = await tempRepo();
  try {
    const fn = (n: number) => `export function f${n}(x: number) {\n  const y = x + ${n};\n  return y;\n}\n`;
    await repo.write('src/math.ts', Array.from({ length: 5 }, (_, i) => fn(i)).join('\n'));
    await repo.write('README.md', '# Demo\n');
    await repo.write('dist/app.min.js', 'var a=1;\n');
    const base = await repo.commit('base');
    await repo.write('src/math.ts', Array.from({ length: 5 }, (_, i) => (i === 2 ? fn(2).replace('x + 2', 'x * 2') : fn(i))).join('\n'));
    await repo.write('dist/app.min.js', 'var a=2;\n');
    await repo.write('docs/new.md', 'hello\n');
    const head = await repo.commit('change');
    await repo.write('.ai-risk-scorer-old/pr.json', '{"left": "over"}\n');

    const ws = await prepareWorkspace({ repoDir: repo.dir, baseSha: base, headSha: head, config: testConfig(), pr: { number: 7 } });
    assert.equal(ws.slices.length, 1);
    assert.deepEqual(ws.generated.map((f) => f.path), ['dist/app.min.js']);
    // Generated files leave the size count only: their content is still reviewed.
    assert.deepEqual(ws.reviewFiles.map((f) => f.path).sort(), ['dist/app.min.js', 'docs/new.md', 'src/math.ts']);

    const patch = await readFile(join(repo.dir, ws.reviewDir, 'patches/src/math.ts.patch'), 'utf8');
    assert.ok(patch.includes('export function f2'), 'function context is in the patch');
    const old = await readFile(join(repo.dir, ws.reviewDir, 'base/src/math.ts'), 'utf8');
    assert.ok(old.includes('x + 2'));
    const prJson = JSON.parse(await readFile(join(repo.dir, ws.reviewDir, 'pr.json'), 'utf8'));
    assert.equal(prJson.number, 7);
    assert.equal(prJson.files.find((f: { path: string }) => f.path === 'dist/app.min.js').generated, true);
    await assert.rejects(stat(join(repo.dir, '.ai-risk-scorer-old')), 'a leftover review folder is removed');
  } finally {
    await repo.cleanup();
  }
});

test('a PR that ships a fake review folder is refused', async () => {
  const repo = await tempRepo();
  try {
    await repo.write('a.txt', '1\n');
    const base = await repo.commit('one');
    await repo.write('.ai-risk-scorer-cafe/pr.json', '{"files": []}\n');
    const head = await repo.commit('plant');
    await assert.rejects(prepareWorkspace({ repoDir: repo.dir, baseSha: base, headSha: head, config: testConfig(), pr: {} }), /shaped like a review folder/);
  } finally {
    await repo.cleanup();
  }
});

test('the workspace refuses a checkout that is not at the head', async () => {
  const repo = await tempRepo();
  try {
    await repo.write('a.txt', '1\n');
    const base = await repo.commit('one');
    await repo.write('a.txt', '2\n');
    await repo.commit('two');
    await assert.rejects(prepareWorkspace({ repoDir: repo.dir, baseSha: base, headSha: base, config: testConfig(), pr: {} }), /expected the PR head/);
  } finally {
    await repo.cleanup();
  }
});

test('lockWorkspace makes the checkout read-only', async () => {
  const repo = await tempRepo();
  try {
    await repo.write('a.txt', '1\n');
    await repo.commit('one');
    await lockWorkspace(repo.dir);
    await assert.rejects(writeFile(join(repo.dir, 'a.txt'), 'changed'));
    await unlockWorkspace(repo.dir);
  } finally {
    await repo.cleanup();
  }
});

test('a .gitattributes in the PR cannot hide a diff or zero its line count', async () => {
  const repo = await tempRepo();
  try {
    await repo.write('src/a.ts', 'export const a = 1;\n');
    const base = await repo.commit('base');
    await repo.write('.gitattributes', '*.ts -diff\n*.ts binary\n');
    await repo.write('src/a.ts', `export const a = 1;\n${'export const b = 2;\n'.repeat(40)}`);
    const head = await repo.commit('head');
    const { files } = await listChanges(repo.dir, base, head);
    const a = files.find((f) => f.path === 'src/a.ts');
    assert.deepEqual([a?.binary, a?.additions], [false, 40]);
    const ws = await prepareWorkspace({ repoDir: repo.dir, baseSha: base, headSha: head, config: testConfig(), pr: {} });
    const patch = await readFile(join(repo.dir, ws.reviewDir, 'patches/src/a.ts.patch'), 'utf8');
    assert.ok(patch.includes('+export const b = 2;'));
  } finally {
    await repo.cleanup();
  }
});

test('symlinks are found in the diff and refused by the workspace', async () => {
  const repo = await tempRepo();
  try {
    await repo.write('a.txt', '1\n');
    const base = await repo.commit('base');
    await symlink('/etc/hosts', join(repo.dir, 'notes.md'));
    const head = await repo.commit('link');
    const { files } = await listChanges(repo.dir, base, head);
    assert.equal(files.find((f) => f.path === 'notes.md')?.special, 'symlink');
    await assert.rejects(prepareWorkspace({ repoDir: repo.dir, baseSha: base, headSha: head, config: testConfig(), pr: {} }), /symlink/);
  } finally {
    await repo.cleanup();
  }
});

test('lines too long for the reader are reported', async () => {
  assert.equal(hasLongLine(`a\n${'x'.repeat(10)}\nb`, 10), false);
  assert.equal(hasLongLine(`a\n${'x'.repeat(11)}`, 10), true);
  const repo = await tempRepo();
  try {
    await repo.write('a.ts', 'export const a = 1;\n');
    const base = await repo.commit('base');
    await repo.write('a.ts', `export const a = 1;${' '.repeat(3000)}hidden();\n`);
    const head = await repo.commit('head');
    const ws = await prepareWorkspace({ repoDir: repo.dir, baseSha: base, headSha: head, config: testConfig(), pr: {} });
    assert.deepEqual(ws.longLines, ['a.ts']);
  } finally {
    await repo.cleanup();
  }
});

test('the base-file reader refuses folders and missing files', async () => {
  const repo = await tempRepo();
  try {
    await repo.write('ai/prompt.md', 'hello\n');
    const base = await repo.commit('base');
    const read = baseFileReader(repo.dir, base);
    assert.equal(await read('./ai/prompt.md'), 'hello\n');
    await assert.rejects(read('ai'));
    await assert.rejects(read('ai/missing.md'));
  } finally {
    await repo.cleanup();
  }
});
