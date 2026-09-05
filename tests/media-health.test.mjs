import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './load-ts.mjs';

const { probeMedia } = loadTs('src/lib/media-health.ts');
const url = 'https://cdn.example/master.m3u8';
const playlist = (body) => new Response(body, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });

test('a blocked playlist fails with its HTTP status', async () => {
  assert.deepEqual(await probeMedia(url, '', async () => new Response('blocked', { status: 403 })),
    { ok: false, status: 403, reason: 'upstream_http_error' });
});

test('HTML disguised as a successful playlist is rejected', async () => {
  assert.equal((await probeMedia(url, '', async () => playlist('<html>Blocked</html>'))).ok, false);
});

test('check variant and first segment, not just the master playlist', async () => {
  const visited = [];
  const result = await probeMedia(url, '', async (target) => {
    visited.push(target.pathname);
    if (target.pathname === '/master.m3u8') return playlist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n720.m3u8');
    if (target.pathname === '/720.m3u8') return playlist('#EXTM3U\n#EXTINF:5,\nfirst.ts');
    return new Response(new Uint8Array([0x47, 1, 2]), { headers: { 'content-type': 'video/mp2t' } });
  });
  assert.equal(result.ok, true);
  assert.deepEqual(visited, ['/master.m3u8', '/720.m3u8', '/first.ts']);
});

test('expired segment access is rejected even when its playlist is valid', async () => {
  const result = await probeMedia(url, '', async (target) => target.pathname.endsWith('.m3u8')
    ? playlist('#EXTM3U\n#EXTINF:5,\nfirst.ts') : new Response('', { status: 401 }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('private redirect and playlist destinations are never requested', async () => {
  for (const first of [
    () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }),
    () => playlist('#EXTM3U\nhttps://127.0.0.1/private'),
  ]) {
    let calls = 0;
    const result = await probeMedia(url, '', async () => { calls++; return first(); });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  }
});

test('unresponsive provider is bounded by the probe deadline', async () => {
  const result = await probeMedia(url, '', (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }), 15);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
});
