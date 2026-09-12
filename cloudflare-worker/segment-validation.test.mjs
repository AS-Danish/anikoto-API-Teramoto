import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bufferCompleteTs } from './segment-validation.js';
const ts = new Uint8Array(188 * 4);
for (let i = 0; i < ts.length; i += 188) ts[i] = 0x47;
test('complete transport stream is retained byte for byte', async () => {
  assert.deepEqual(await bufferCompleteTs(new Response(ts).body, ts.length), ts);
});
test('rejects the observed mid-packet truncation', async () => {
  await assert.rejects(bufferCompleteTs(new Response(ts.slice(0, 401)).body, ts.length), /Incomplete/);
});
test('rejects missing whole packets using the upstream length', async () => {
  await assert.rejects(bufferCompleteTs(new Response(ts.slice(0, 188)).body, ts.length), /Incomplete/);
});
test('bounds memory and rejects non-TS data', async () => {
  await assert.rejects(bufferCompleteTs(new Response(ts).body, null, 200), /limit/);
  await assert.rejects(bufferCompleteTs(new Response(new Uint8Array(188)).body, null), /alignment/);
});
