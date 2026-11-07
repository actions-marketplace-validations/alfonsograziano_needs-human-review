import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { generatedGlobs, isGenerated } from './gates.ts';
import type { Config } from './inputs.ts';
import { estimateTokens, makeSlices, type Hunk, type ReviewFile, type Slice } from './slices.ts';
import type { ChangedFile, FileStatus } from './types.ts';

const run = promisify(execFile);
const PREFIX = '.needs-human-review-';

/**
 * Lines longer than this are cut by the reviewer's read tool (OpenCode cuts at
 * 2,000 characters) while the read still counts as covering the line. Code past
 * the cut would be invisible, so a PR with such a line needs a human.
 */
export const MAX_LINE_CHARS = 2000;

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' });
  return stdout;
}

/**
 * Runs `git diff` without letting the PR steer it: attributes come from the
 * empty tree, so a `.gitattributes` in the PR cannot mark code as binary or
 * hide its diff, and no external diff or textconv driver runs.
 */
export function diff(cwd: string, emptyTree: string, args: string[]): Promise<string> {
  return git(cwd, ['-c', 'color.ui=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', `--attr-source=${emptyTree}`, 'diff', '--no-ext-diff', '--no-textconv', ...args]);
}

/** The id of the empty tree in this repo's hash format. */
export async function emptyTreeOf(cwd: string): Promise<string> {
  return (await git(cwd, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
}

const STATUS: Record<string, FileStatus> = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied', T: 'type-changed' };

/**
 * Reads `git diff -z --raw -M` and returns the paths whose old or new version
 * is a symlink (mode 120000) or a submodule (mode 160000), by both names.
 */
export function parseSpecialModes(raw: string): Map<string, 'symlink' | 'submodule'> {
  const out = new Map<string, 'symlink' | 'submodule'>();
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; ) {
    const meta = tokens[i++];
    if (!meta?.startsWith(':')) continue;
    const [oldMode = '', newMode = '', , , status = ''] = meta.slice(1).split(' ');
    const paths = status.startsWith('R') || status.startsWith('C') ? [tokens[i++] ?? '', tokens[i++] ?? ''] : [tokens[i++] ?? ''];
    const modes = [oldMode, newMode];
    const kind = modes.includes('120000') ? 'symlink' : modes.includes('160000') ? 'submodule' : undefined;
    if (kind) for (const p of paths) out.set(p, kind);
  }
  return out;
}

/** Parses `git diff -z --name-status -M` and `git diff -z --numstat -M` (and `--raw` for special modes) into one list. */
export function parseChanges(nameStatus: string, numstat: string, raw = ''): ChangedFile[] {
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
  const special = parseSpecialModes(raw);
  for (const f of files) {
    const c = counts.get(f.path);
    if (c) Object.assign(f, { additions: c.add, deletions: c.del, binary: c.binary });
    const kind = special.get(f.path) ?? (f.previousPath ? special.get(f.previousPath) : undefined);
    if (kind) f.special = kind;
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
export async function listChanges(repoDir: string, baseSha: string, headSha: string): Promise<{ mergeBase: string; emptyTree: string; files: ChangedFile[] }> {
  const mergeBase = (await git(repoDir, ['merge-base', baseSha, headSha])).trim();
  const emptyTree = await emptyTreeOf(repoDir);
  const range = [mergeBase, headSha];
  const files = parseChanges(
    await diff(repoDir, emptyTree, ['-z', '--name-status', '-M', ...range]),
    await diff(repoDir, emptyTree, ['-z', '--numstat', '-M', ...range]),
    await diff(repoDir, emptyTree, ['-z', '--raw', '-M', ...range]),
  );
  return { mergeBase, emptyTree, files };
}

/** True when any line is longer than the reader can show. Patch lines carry one extra prefix character. */
export function hasLongLine(text: string, limit: number): boolean {
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    if (end - start > limit) return true;
    start = end + 1;
  }
  return false;
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
  /** Changed files with a line too long for the reviewer to read in full. */
  longLines: string[];
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
  const { mergeBase, emptyTree, files } = await listChanges(repoDir, baseSha, headSha);
  const range = [mergeBase, headSha];
  // The self-protection gate already stops these. This is the second lock.
  const planted = files.filter((f) => f.path.startsWith(PREFIX) || f.previousPath?.startsWith(PREFIX));
  if (planted.length > 0) throw new Error(`the PR contains files shaped like a review folder: ${planted.map((f) => f.path).join(', ')}`);
  // The special-files gate already stops these too. The reviewer must never be
  // made to open a link that leads out of the checkout, so check the disk as well.
  for (const f of files) {
    if (f.special) throw new Error(`the PR changes a ${f.special}: ${f.path}`);
    if (f.status === 'removed') continue;
    const st = await lstat(join(repoDir, f.path));
    if (!st.isFile()) throw new Error(`the PR changes something that is not a regular file: ${f.path}`);
  }

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
  const longLines: string[] = [];
  for (const f of files) {
    // Generated files only leave the size count. Their content is still
    // reviewed: the name is chosen by the PR, so it proves nothing.
    const isGen = generatedFiles.includes(f);
    const entry: Record<string, unknown> = { ...f, generated: isGen };
    entries.push(entry);

    const paths = f.previousPath ? [f.previousPath, f.path] : [f.path];
    const patch = f.binary
      ? `Binary file ${f.path} changed (${f.status}). Its content is not shown.\n`
      : await diff(repoDir, emptyTree, ['-M', '--function-context', ...range, '--', ...paths]);
    const patchFile = `${reviewDir}/patches/${f.path}.patch`;
    await writeIn(repoDir, patchFile, patch);
    patchTexts.set(f.path, patch);
    entry.patch = patchFile;

    const oldPath = f.previousPath ?? f.path;
    if (f.status !== 'added' && !f.binary) {
      const old = await git(repoDir, ['cat-file', 'blob', `${mergeBase}:${oldPath}`]);
      await writeIn(repoDir, `${reviewDir}/base/${oldPath}`, old);
      entry.base = `${reviewDir}/base/${oldPath}`;
    }

    let fileText = '';
    if (f.status !== 'removed' && !f.binary) fileText = await readFile(join(repoDir, f.path), 'utf8');
    if (!f.binary && (hasLongLine(fileText, MAX_LINE_CHARS) || hasLongLine(patch, MAX_LINE_CHARS + 1))) longLines.push(f.path);
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

  return { repoDir, reviewDir, mergeBase, headSha, files, generated: generatedFiles, reviewFiles, slices, longLines };
}

/** Second lock after the agent's own permissions: nothing in the checkout is writable. */
export async function lockWorkspace(repoDir: string): Promise<void> {
  await run('chmod', ['-R', 'a-w', repoDir]);
}

export async function unlockWorkspace(repoDir: string): Promise<void> {
  await run('chmod', ['-R', 'u+w', repoDir]);
}

/**
 * Reads a file as it is on the base branch. `cat-file blob` fails on a folder
 * or a missing path, where `git show` would print a tree listing.
 */
export function baseFileReader(repoDir: string, baseSha: string) {
  return async (path: string): Promise<string> => git(repoDir, ['cat-file', 'blob', `${baseSha}:${path.replace(/^\.?\//, '')}`]);
}
