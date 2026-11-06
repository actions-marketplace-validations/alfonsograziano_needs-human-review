import { matchesGlob } from 'node:path/posix';

/** Paths that always need a human. No input can remove them. */
export const SELF_PROTECTED_PATHS: readonly string[] = [
  '.github/workflows/**',
  '.github/actions/**',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  // A PR that ships something shaped like our review folder is trying to fool the reviewer.
  '.ai-risk-scorer-*/**',
  // Attributes change how git diffs a file: binary, -diff, textconv. The action
  // ignores the PR's attributes, and a PR that edits them needs a human.
  '.gitattributes',
];

/** Dependency lock files, at any depth. A change here is a dependency change: always a human. */
export const LOCKFILES: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'packages.lock.json',
  'gradle.lockfile',
  'pubspec.lock',
  'Podfile.lock',
  'mix.lock',
  'flake.lock',
];

/** Binary files the reviewer may skip: media and fonts. Any other binary needs a human. */
const BINARY_ASSET_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'mp3', 'mp4', 'webm', 'ogg', 'wav', 'mov',
]);

/** Generated files: left out of the size count only. Their content is still reviewed. */
export const GENERATED_DEFAULTS: readonly string[] = [
  ...LOCKFILES,
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.snap',
  '**/__snapshots__/**',
  '**/dist/**',
  '**/*.generated.*',
  '**/*.pb.go',
];

const DOC_PATHS: readonly string[] = ['*.md', '*.mdx', '*.txt', '*.rst', 'docs/**', 'LICENSE*', '.github/ISSUE_TEMPLATE/**'];
const TEST_PATHS: readonly string[] = [
  '*.test.*',
  '*.spec.*',
  '*_test.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
];

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeGlob(glob: string): string {
  let g = normalizePath(glob.trim());
  if (g.startsWith('/')) g = g.slice(1);
  if (g.endsWith('/')) g = `${g}**`;
  return g;
}

/**
 * Matches like .gitignore. A glob with no slash matches a file or a folder of
 * that name anywhere in the tree (`*.tf` matches `infra/main.tf`, `payments`
 * matches `src/payments/charge.ts`). A glob with a slash matches from the repo
 * root, and when it names a folder it covers everything inside it
 * (`src/payments` and `db/migrations` protect the files under them). Dot
 * files and folders match too.
 */
export function matchesGlobPattern(filePath: string, glob: string): boolean {
  const path = normalizePath(filePath);
  const g = normalizeGlob(glob);
  if (g === '') return false;
  if (!g.includes('/')) {
    return matchesGlob(path, g) || path.split('/').some((segment) => matchesGlob(segment, g));
  }
  // `**/x` should also match `x` at the root.
  const candidates = g.startsWith('**/') ? [g, g.slice(3)] : [g];
  return candidates.some((c) => matchesGlob(path, c) || (!c.endsWith('**') && matchesGlob(path, `${c}/**`)));
}

/** Compares two repo paths literally, ignoring a leading `./` or `/`. For config that names one file, not a glob. */
export function samePath(a: string, b: string): boolean {
  const clean = (p: string) => normalizePath(p.trim()).replace(/^\/+/, '');
  return clean(a) === clean(b);
}

export function isLockfile(filePath: string): boolean {
  return matchesAny(filePath, LOCKFILES);
}

export function isBinaryAsset(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  return dot > filePath.lastIndexOf('/') && BINARY_ASSET_EXTENSIONS.has(filePath.slice(dot + 1).toLowerCase());
}

export function matchesAny(filePath: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlobPattern(filePath, g));
}

/** Throws on a glob that cannot be used, so bad config fails loudly. */
export function validateGlob(glob: string): void {
  const g = normalizeGlob(glob);
  if (g === '') throw new Error('empty glob');
  matchesGlob('probe', g);
}

export function isDocOrTest(filePath: string): boolean {
  return matchesAny(filePath, DOC_PATHS) || matchesAny(filePath, TEST_PATHS);
}

export function isTestFile(filePath: string): boolean {
  return matchesAny(filePath, TEST_PATHS);
}
