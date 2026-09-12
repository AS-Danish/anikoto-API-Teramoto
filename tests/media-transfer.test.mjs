import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './load-ts.mjs';
const { withMediaIdleTimeout } = loadTs('src/lib/media-transfer.ts');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('a progressing body can outlive the idle timeout', async () => {
  let chunks = 0;
  const controller = new AbortController();
  const body = new ReadableStream({
    async pull(output) {
      await delay(20);
      if (chunks++ < 8) output.enqueue(new Uint8Array([1]));
      else output.close();
    },
  });
  const bytes = await new Response(withMediaIdleTimeout(body, controller, 100)).arrayBuffer();
  assert.equal(bytes.byteLength, 8);
  assert.equal(controller.signal.aborted, false);
});

test('stalled body errors and cancels upstream', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(new Response(withMediaIdleTimeout(body, controller, 20)).arrayBuffer(), /timed out/);
  assert.equal(controller.signal.aborted, true);
  assert.equal(cancelled, true);
});

test('downstream cancellation cancels upstream', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await withMediaIdleTimeout(body, controller).cancel();
  assert.equal(controller.signal.aborted, true);
  assert.equal(cancelled, true);
});
