import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchMediaWithRetry } from './media-retry.js';

test('503 retries the same segment and cancels the failed body', async () => {
  let calls = 0, cancelled = false;
  const waits = [];
  const result = await fetchMediaWithRetry('https://cdn.example/segment.ts', {}, async url => {
    assert.equal(url, 'https://cdn.example/segment.ts');
    return ++calls === 1
      ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 })
      : new Response('media');
  }, async ms => waits.push(ms));
  assert.equal(await result.text(), 'media');
  assert.equal(cancelled, true);
  assert.deepEqual(waits, [250]);
  assert.equal(calls, 2);
});

test('persistent 503 is bounded to three requests', async () => {
  let calls = 0;
  const result = await fetchMediaWithRetry('https://cdn.example/a', {}, async () => {
    calls++;
    return new Response('', { status: 503 });
  }, async () => {});
  assert.equal(result.status, 503);
  assert.equal(calls, 3);
});

test('authorization, rate limits and long cooldowns are returned without retry', async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    let calls = 0;
    const result = await fetchMediaWithRetry('https://cdn.example/a', {}, async () => {
      calls++;
      return new Response('', { status, headers: { 'Retry-After': '60' } });
    }, async () => assert.fail('unexpected retry'));
    assert.equal(result.status, status);
    assert.equal(calls, 1);
  }
});

test('temporary transport failure recovers, cancelled requests never retry', async () => {
  let calls = 0;
  const result = await fetchMediaWithRetry('https://cdn.example/a', {}, async () => {
    if (++calls === 1) throw new TypeError('network failure');
    return new Response('ok');
  }, async () => {});
  assert.equal(await result.text(), 'ok');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchMediaWithRetry('https://cdn.example/a', { signal: controller.signal },
    async () => assert.fail('cancelled request was sent')));
});
