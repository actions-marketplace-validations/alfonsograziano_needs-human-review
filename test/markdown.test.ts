import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOwnComment } from '../src/github.ts';
import { code, inline } from '../src/markdown.ts';

test('code() keeps backticks and newlines inside one code span', () => {
  assert.equal(code('a.ts'), '`a.ts`');
  assert.equal(code('x`\n### hi\n`.tf'), '``x` ### hi `.tf``');
  assert.equal(code('`a'), '`` `a ``');
});

test('inline() cannot start blocks, ping people, embed images or HTML', () => {
  const out = inline('ok\n\n### 🟢 merged\ncc @acme/team ![](https://e.example/p.png) <img src=x> [x](https://e.example)');
  assert.ok(!out.includes('\n'));
  assert.ok(!out.includes('@acme'));
  assert.ok(!out.includes('!['));
  assert.ok(!out.includes('<img'));
  assert.ok(!out.includes(']('));
  assert.equal(inline('# heading'), '\\# heading');
  assert.equal(inline('see `a<b>.ts`'), 'see `a<b>.ts`');
  assert.equal(inline('x'.repeat(600)).length, 500);
});

test('only a bot comment that starts with the marker is ours', () => {
  const marker = '<!-- m -->';
  assert.equal(isOwnComment({ id: 1, body: `${marker}\nhi`, user: { login: 'github-actions[bot]', type: 'Bot' } }, marker), true);
  assert.equal(isOwnComment({ id: 2, body: `${marker}\nhi`, user: { login: 'mallory', type: 'User' } }, marker), false);
  assert.equal(isOwnComment({ id: 3, body: `quote: ${marker}`, user: { login: 'other[bot]', type: 'Bot' } }, marker), false);
});
