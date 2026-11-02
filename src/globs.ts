import { matchesGlob } from 'node:path/posix';

/** Paths that always need a human. No input can remove them. */
export const SELF_PROTECTED_PATHS: readonly string[] = [
  '.github/workflows/**',
  '.github/actions/**',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
];

/** Generated files: not counted for size, patches not sent for review. */
export const GENERATED_DEFAULTS: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
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
 * Matches like .gitignore: a glob with no slash matches the file name anywhere
 * in the tree (`*.tf` matches `infra/main.tf`), a glob with a slash matches
 * from the repo root (`payments/**`). Dot files and folders match too.
 */
export function matchesGlobPattern(filePath: string, glob: string): boolean {
  const path = normalizePath(filePath);
  const g = normalizeGlob(glob);
  if (g === '') return false;
  if (!g.includes('/')) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return matchesGlob(base, g) || matchesGlob(path, g);
  }
  if (matchesGlob(path, g)) return true;
  // `**/x` should also match `x` at the root.
  if (g.startsWith('**/')) return matchesGlob(path, g.slice(3));
  return false;
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
