import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { hedgedPair } = loadTs('src/lib/providers/hedged.ts');

test('fast primary avoids duplicate upstream requests', async () => {
  let calls = 0;
  assert.equal(await hedgedPair(async () => 'primary', async () => { calls++; }, 20), 'primary');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 0);
});
test('slow primary does not hold up a valid fallback', async () => {
  let finish;
  const primary = new Promise(resolve => { finish = resolve; });
  assert.equal(await hedgedPair(() => primary, async () => 'fallback', 5), 'fallback');
  finish('late primary');
});
test('failure starts fallback immediately and never wins', async () => {
  assert.equal(await hedgedPair(async () => { throw Error('empty'); }, async () => 'valid', 10000), 'valid');
});
test('both errors reject without hanging', async () => {
  await assert.rejects(hedgedPair(async () => { throw Error('a'); }, async () => { throw Error('b'); }, 5));
});
