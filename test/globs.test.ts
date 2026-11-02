import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDocOrTest, matchesAny, matchesGlobPattern, SELF_PROTECTED_PATHS } from '../src/globs.ts';

test('a glob without a slash matches the file name anywhere', () => {
  assert.equal(matchesGlobPattern('infra/prod/main.tf', '*.tf'), true);
  assert.equal(matchesGlobPattern('main.tf', '*.tf'), true);
  assert.equal(matchesGlobPattern('config/.env.local', '.env*'), true);
  assert.equal(matchesGlobPattern('src/main.ts', '*.tf'), false);
});

test('a glob with a slash matches from the repo root', () => {
  assert.equal(matchesGlobPattern('payments/charge.ts', 'payments/**'), true);
  assert.equal(matchesGlobPattern('payments/a/b/c.ts', 'payments/**'), true);
  assert.equal(matchesGlobPattern('src/payments/charge.ts', 'payments/**'), false);
  assert.equal(matchesGlobPattern('src/payments/charge.ts', '**/payments/**'), true);
});

test('**/ also matches at the root, and a trailing slash means the whole folder', () => {
  assert.equal(matchesGlobPattern('migrations/001.sql', '**/migrations/**'), true);
  assert.equal(matchesGlobPattern('db/migrations/001.sql', '**/migrations/**'), true);
  assert.equal(matchesGlobPattern('auth/login.ts', 'auth/'), true);
  assert.equal(matchesGlobPattern('./auth/login.ts', '/auth/**'), true);
});

test('self-protected paths cover workflows, actions and CODEOWNERS', () => {
  for (const p of ['.github/workflows/ci.yml', '.github/actions/x/action.yml', 'CODEOWNERS', '.github/CODEOWNERS']) {
    assert.equal(matchesAny(p, SELF_PROTECTED_PATHS), true, p);
  }
  assert.equal(matchesAny('.github/dependabot.yml', SELF_PROTECTED_PATHS), false);
});

test('docs and tests are recognised', () => {
  assert.equal(isDocOrTest('README.md'), true);
  assert.equal(isDocOrTest('docs/setup/guide.html'), true);
  assert.equal(isDocOrTest('src/date.test.ts'), true);
  assert.equal(isDocOrTest('test/unit/date.ts'), true);
  assert.equal(isDocOrTest('src/date.ts'), false);
});
