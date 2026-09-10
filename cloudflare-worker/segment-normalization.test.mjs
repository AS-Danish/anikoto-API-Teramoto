import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSegment } from './segment-normalization.js';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(61).fill(0)]);
const ts = new Uint8Array(188 * 4).fill(255);
for (let i = 0; i < ts.length; i += 188) ts.set([0x47, 0x40, 0, 0x10], i);
const wrapped = Uint8Array.from([...png, ...ts]);

function chunks(bytes, size) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset = Math.min(offset + size, bytes.length);
    },
  });
}

for (const size of [1, 7, 188, 1024]) {
  test(`strips PNG prefix with ${size}-byte chunks`, async () => {
    const result = await normalizeSegment(chunks(wrapped, size));
    assert.equal(result.removedBytes, png.length);
    assert.deepEqual(new Uint8Array(await new Response(result.body).arrayBuffer()), ts);
  });
}

for (const [name, bytes] of [['TS', ts], ['image', png], ['empty', new Uint8Array()],
  ['large image', new Uint8Array(100000).map((_, i) => png[i] ?? 0)]]) {
  test(`preserves ${name} bytes`, async () => {
    const result = await normalizeSegment(chunks(bytes, 997));
    assert.equal(result.removedBytes, 0);
    assert.deepEqual(new Uint8Array(await new Response(result.body).arrayBuffer()), bytes);
  });
}

test('cancelling downstream cancels upstream', async () => {
  let cancelled = false;
  const result = await normalizeSegment(new ReadableStream({
    start(controller) { controller.enqueue(wrapped); },
    cancel() { cancelled = true; },
  }));
  await result.body.cancel();
  assert.equal(cancelled, true);
});
