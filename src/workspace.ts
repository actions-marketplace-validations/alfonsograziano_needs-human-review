import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { generatedGlobs, isGenerated } from './gates.ts';
import type { Config } from './inputs.ts';
import { estimateTokens, makeSlices, type Hunk, type ReviewFile, type Slice } from './slices.ts';
import type { ChangedFile, FileStatus } from './types.ts';

const run = promisify(execFile);
const PREFIX = '.ai-risk-scorer-';

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' });
  return stdout;
}

const STATUS: Record<string, FileStatus> = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied', T: 'type-changed' };

/** Parses `git diff -z --name-status -M` and `git diff -z --numstat -M` into one list. */
export function parseChanges(nameStatus: string, numstat: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const ns = nameStatus.split('\0');
  for (let i = 0; i < ns.length; ) {
    const code = ns[i++];
    if (!code) continue;
    const status = STATUS[code[0] ?? ''] ?? 'modified';
    if (status === 'renamed' || status === 'copied') {
      const previousPath = ns[i++] ?? '';
      const path = ns[i++] ?? '';
      files.push({ path, previousPath, status, additions: 0, deletions: 0, binary: false });
    } else {
      files.push({ path: ns[i++] ?? '', status, additions: 0, deletions: 0, binary: false });
    }
  }
  const counts = new Map<string, { add: number; del: number; binary: boolean }>();
  const nm = numstat.split('\0');
  for (let i = 0; i < nm.length; ) {
    const entry = nm[i++];
    if (!entry) continue;
    const [add = '0', del = '0', path = ''] = entry.split('\t');
    const binary = add === '-' && del === '-';
    const value = { add: binary ? 0 : Number(add), del: binary ? 0 : Number(del), binary };
    if (path === '') {
      i++; // old path of a rename
      counts.set(nm[i++] ?? '', value);
    } else {
      counts.set(path, value);
    }
  }
  for (const f of files) {
    const c = counts.get(f.path);
    if (c) Object.assign(f, { additions: c.add, deletions: c.del, binary: c.binary });
  }
  return files;
}

export function countLines(text: string): number {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** Splits a one-file patch into its header and its hunks. */
export function parsePatch(patch: string): { header: string; hunks: { text: string; newStart: number; newLines: number }[] } {
  const lines = patch.split('\n');
  const first = lines.findIndex((l) => l.startsWith('@@'));
  if (first === -1) return { header: patch, hunks: [] };
  const header = lines.slice(0, first).join('\n');
  const hunks: { text: string; newStart: number; newLines: number }[] = [];
  let current: string[] = [];
  const push = () => {
    if (current.length === 0) return;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(current[0] ?? '');
    hunks.push({ text: current.join('\n'), newStart: Number(m?.[1] ?? 1), newLines: Number(m?.[2] ?? 1) });
    current = [];
  };
  for (const line of lines.slice(first)) {
    if (line.startsWith('@@')) push();
    current.push(line);
  }
  push();
  return { header, hunks };
}

/** Every file the PR changes, between the merge base and the head. */
export async function listChanges(repoDir: string, baseSha: string, headSha: string): Promise<{ mergeBase: string; files: ChangedFile[] }> {
  const mergeBase = (await git(repoDir, ['merge-base', baseSha, headSha])).trim();
  const range = [mergeBase, headSha];
  const files = parseChanges(
    await git(repoDir, ['diff', '-z', '--name-status', '-M', ...range]),
    await git(repoDir, ['diff', '-z', '--numstat', '-M', ...range]),
  );
  return { mergeBase, files };
}

export interface Workspace {
  repoDir: string;
  /** Review folder name, relative to repoDir. */
  reviewDir: string;
  mergeBase: string;
  headSha: string;
  files: ChangedFile[];
  generated: ChangedFile[];
  reviewFiles: ReviewFile[];
  slices: Slice[];
}

export interface PrepareOptions {
  repoDir: string;
  baseSha: string;
  headSha: string;
  config: Config;
  pr: Record<string, unknown>;
}

async function writeIn(root: string, rel: string, content: string): Promise<void> {
  const target = join(root, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

/**
 * Builds the review folder inside the checkout: one patch per changed file
 * (with function context), the old version of each file, the slice plan and
 * pr.json. The checkout must already be at the head SHA.
 */
export async function prepareWorkspace(opts: PrepareOptions): Promise<Workspace> {
  const { repoDir, baseSha, headSha, config } = opts;
  const actualHead = (await git(repoDir, ['rev-parse', 'HEAD'])).trim();
  if (actualHead !== headSha) throw new Error(`checkout is at ${actualHead}, expected the PR head ${headSha}`);
  const { mergeBase, files } = await listChanges(repoDir, baseSha, headSha);
  const range = [mergeBase, headSha];
  // The self-protection gate already stops these. This is the second lock.
  const planted = files.filter((f) => f.path.startsWith(PREFIX) || f.previousPath?.startsWith(PREFIX));
  if (planted.length > 0) throw new Error(`the PR contains files shaped like a review folder: ${planted.map((f) => f.path).join(', ')}`);

  // Leftovers from an earlier run in the same checkout.
  for (const entry of await readdir(repoDir)) {
    if (entry.startsWith(PREFIX)) await rm(join(repoDir, entry), { recursive: true, force: true });
  }
  const reviewDir = `${PREFIX}${randomBytes(4).toString('hex')}`;
  await mkdir(join(repoDir, reviewDir));
  const generated = generatedGlobs(config);
  const generatedFiles = files.filter((f) => isGenerated(f, generated));

  const reviewFiles: ReviewFile[] = [];
  const patchTexts = new Map<string, string>();
  const entries: Record<string, unknown>[] = [];
  for (const f of files) {
    const isGen = generatedFiles.includes(f);
    const entry: Record<string, unknown> = { ...f, generated: isGen };
    entries.push(entry);
    if (isGen) continue;

    const paths = f.previousPath ? [f.previousPath, f.path] : [f.path];
    const patch = f.binary
      ? `Binary file ${f.path} changed (${f.status}). Its content is not shown.\n`
      : await git(repoDir, ['diff', '-M', '--function-context', ...range, '--', ...paths]);
    const patchFile = `${reviewDir}/patches/${f.path}.patch`;
    await writeIn(repoDir, patchFile, patch);
    patchTexts.set(f.path, patch);
    entry.patch = patchFile;

    const oldPath = f.previousPath ?? f.path;
    if (f.status !== 'added' && !f.binary) {
      const old = await git(repoDir, ['show', `${mergeBase}:${oldPath}`]);
      await writeIn(repoDir, `${reviewDir}/base/${oldPath}`, old);
      entry.base = `${reviewDir}/base/${oldPath}`;
    }

    let fileText = '';
    if (f.status !== 'removed' && !f.binary) fileText = await readFile(join(repoDir, f.path), 'utf8');
    const { hunks } = parsePatch(patch);
    reviewFiles.push({
      path: f.path,
      patchFile,
      patchLines: countLines(patch),
      patchTokens: estimateTokens(patch),
      fileTokens: estimateTokens(fileText),
      totalLines: countLines(fileText),
      hunks: hunks.map((h): Hunk => ({ newStart: h.newStart, newLines: h.newLines, tokens: estimateTokens(h.text), patchLines: countLines(h.text) })),
    });
  }

  const slices = makeSlices(reviewFiles, config.sliceMaxTokens);
  for (const s of slices) {
    for (const item of s.items) {
      if (!item.part) continue;
      const parsed = parsePatch(patchTexts.get(item.path) ?? '');
      const text = [parsed.header, ...item.part.hunks.map((h) => parsed.hunks[h]?.text ?? '')].join('\n');
      await writeIn(repoDir, item.part.patchFile, `${text}\n`);
    }
    await writeIn(repoDir, `${reviewDir}/slices/${s.index}.json`, JSON.stringify({ slice: s.index, of: slices.length, items: s.items }, null, 2));
  }
  await writeIn(repoDir, `${reviewDir}/pr.json`, JSON.stringify({ ...opts.pr, mergeBase, headSha, slices: slices.length, files: entries }, null, 2));

  return { repoDir, reviewDir, mergeBase, headSha, files, generated: generatedFiles, reviewFiles, slices };
}

/** Second lock after the agent's own permissions: nothing in the checkout is writable. */
export async function lockWorkspace(repoDir: string): Promise<void> {
  await run('chmod', ['-R', 'a-w', repoDir]);
}

export async function unlockWorkspace(repoDir: string): Promise<void> {
  await run('chmod', ['-R', 'u+w', repoDir]);
}

/** Reads a file as it is on the base branch. */
export function baseFileReader(repoDir: string, baseSha: string) {
  return async (path: string): Promise<string> => git(repoDir, ['show', `${baseSha}:${path}`]);
}
