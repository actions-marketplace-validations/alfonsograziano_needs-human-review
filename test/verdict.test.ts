import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, type VerdictRules } from '../src/verdict.ts';

const good = {
  decision: 'safe',
  risk: 'low',
  confidence: 4,
  summary: 'Fixes a typo.',
  reasons: ['Only the README changes.'],
  risk_areas: [],
  files_reviewed: ['README.md'],
  affected_code: [],
};
const docs: VerdictRules = { role: 'slice', sliceFiles: ['README.md'], runtimeChanged: false };
const code: VerdictRules = { role: 'slice', sliceFiles: ['src/a.ts'], runtimeChanged: true };
const parse = (v: unknown, rules = docs) => parseVerdict(JSON.stringify(v), rules);

test('a good verdict parses', () => {
  const r = parse(good);
  assert.equal(r.ok, true);
});

test('the last JSON object wins, inside a code fence and after prose', () => {
  const text = `I looked at it. Example: {"decision": "needs_human"}\n\n\`\`\`json\n${JSON.stringify(good, null, 2)}\n\`\`\``;
  const r = parseVerdict(text, docs);
  assert.ok(r.ok && r.verdict.decision === 'safe');
});

test('braces inside strings do not break parsing', () => {
  const r = parse({ ...good, summary: 'Changes the {x} template and a "quote".' });
  assert.equal(r.ok, true);
});

test('no JSON, missing fields and extra fields are invalid', () => {
  assert.equal(parseVerdict('looks fine to me', docs).ok, false);
  const { reasons: _drop, ...noReasons } = good;
  assert.equal(parse(noReasons).ok, false);
  assert.equal(parse({ ...good, merge_now: true }).ok, false);
});

test('a percentage confidence is invalid', () => {
  assert.equal(parse({ ...good, confidence: 0.86 }).ok, false);
  assert.equal(parse({ ...good, confidence: 6 }).ok, false);
});

test('safe with high risk is a contradiction', () => {
  assert.equal(parse({ ...good, risk: 'high' }).ok, false);
});

test('a slice reviewer must list every file in its slice', () => {
  const r = parseVerdict(JSON.stringify(good), { role: 'slice', sliceFiles: ['README.md', 'src/a.ts'], runtimeChanged: false });
  assert.ok(!r.ok && r.error.includes('src/a.ts'));
});

test('safe on runtime code needs the impact pass', () => {
  const base = { ...good, files_reviewed: ['src/a.ts'] };
  assert.equal(parse(base, code).ok, false);
  assert.equal(parse({ ...base, affected_code: [{ location: 'src/b.ts:10', why: 'Calls a().' }] }, code).ok, true);
  assert.equal(parse({ ...base, decision: 'needs_human', risk: 'medium' }, code).ok, true);
});
