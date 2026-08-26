import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { webcrypto } from 'node:crypto';

import worker, { testHelpers } from './proxy.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const secret = 'test-only-signing-secret-with-more-than-32-characters';
const allowedOrigin = 'http://localhost:3000';
const realFetch = globalThis.fetch;

function limiter(success = true) {
  return { limit: async () => ({ success }) };
}

function environment(overrides = {}) {
  return {
    PROXY_SIGNING_SECRET: secret,
    ALLOWED_CORS_ORIGINS: allowedOrigin,
    APPROVED_STREAM_HOSTS: 'cdn.watching.onl,*.anivideo.sbs,*.akirax.buzz,*.megaplay.buzz',
    BURST_RATE_LIMITER: limiter(),
    SUSTAINED_RATE_LIMITER: limiter(),
    ...overrides,
  };
}

async function signedResolverRequest(target) {
  const request = await signedRequest(target, { referer: 'https://anikoto.net/watch/example/ep-1' });
  const url = new URL(request.url);
  url.pathname = '/resolve';
  return new Request(url, { headers: request.headers });
}

async function signedRequest(target, options = {}) {
  const expiresAt = options.expiresAt ?? Math.floor(Date.now() / 1_000) + 300;
  const referer = options.referer ?? 'https://megaplay.buzz/';
  const signature = await testHelpers.signTarget(secret, target, referer, expiresAt);
  const url = new URL('https://proxy.example/');
  url.searchParams.set('url', target);
  url.searchParams.set('referer', referer);
  url.searchParams.set('exp', String(expiresAt));
  url.searchParams.set('v', '1');
  url.searchParams.set('sig', signature);
  return new Request(url, {
    headers: {
      Origin: options.origin ?? allowedOrigin,
      'CF-Connecting-IP': '203.0.113.8',
    },
  });
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('health check is available without a proxy signature', async () => {
  const response = await worker.fetch(
    new Request('https://proxy.example/health', { headers: { Origin: allowedOrigin } }),
    environment(),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), allowedOrigin);
});

test('rejects browser origins outside the configured list', async () => {
  const request = await signedRequest('https://cdn.watching.onl/master.m3u8', {
    origin: 'https://attacker.example',
  });
  const response = await worker.fetch(request, environment());
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('rejects unsigned and expired URLs', async () => {
  const unsigned = await worker.fetch(
    new Request('https://proxy.example/?url=https%3A%2F%2Fcdn.watching.onl%2Fmaster.m3u8'),
    environment(),
  );
  assert.equal(unsigned.status, 401);

  const expired = await worker.fetch(
    await signedRequest('https://cdn.watching.onl/master.m3u8', {
      expiresAt: Math.floor(Date.now() / 1_000) - 120,
    }),
    environment(),
  );
  assert.equal(expired.status, 401);
});

test('blocks local addresses and unapproved public hosts before fetch', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('unexpected');
  };

  const privateResponse = await worker.fetch(
    await signedRequest('https://127.0.0.1/video.ts'),
    environment({ APPROVED_STREAM_HOSTS: '127.0.0.1' }),
  );
  assert.equal(privateResponse.status, 403);

  const unapprovedResponse = await worker.fetch(
    await signedRequest('https://example.com/video.ts'),
    environment(),
  );
  assert.equal(unapprovedResponse.status, 403);
  assert.equal(calls, 0);
});

test('rejects redirects to destinations outside the approved host list', async () => {
  globalThis.fetch = async () => new Response(null, {
    status: 302,
    headers: { Location: 'https://example.com/private.ts' },
  });
  const response = await worker.fetch(
    await signedRequest('https://cdn.watching.onl/master.m3u8'),
    environment(),
  );
  assert.equal(response.status, 502);
});

test('rewrites every manifest child with a valid time-limited signature', async () => {
  globalThis.fetch = async () => new Response(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nsegment-1.ts\n',
    { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } },
  );
  const response = await worker.fetch(
    await signedRequest('https://cdn.watching.onl/path/master.m3u8'),
    environment(),
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /URI="https:\/\/proxy\.example\//);
  assert.match(body, /url=https%3A%2F%2Fcdn\.watching\.onl%2Fpath%2Fsegment-1\.ts/);
  assert.match(body, /&exp=\d+&v=1&sig=[a-f0-9]{64}/);
});

test('rewrites approved cross-host HLS children used by watching.onl', async () => {
  globalThis.fetch = async () => new Response(
    '#EXTM3U\nhttps://fntb0.anivideo.sbs/media/segment-1.ts\n',
    { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } },
  );
  const response = await worker.fetch(
    await signedRequest('https://cdn.watching.onl/path/quality.m3u8'),
    environment(),
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /url=https%3A%2F%2Ffntb0\.anivideo\.sbs%2Fmedia%2Fsegment-1\.ts/);
});

test('returns 429 when either configured rate limit rejects the client', async () => {
  const response = await worker.fetch(
    await signedRequest('https://cdn.watching.onl/video.ts'),
    environment({ BURST_RATE_LIMITER: limiter(false) }),
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
});

test('resolves a signed MegaPlay embed without exposing an open resolver', async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith('/stream/s-2/')) {
      return new Response('<html><title>File 178952 - MegaPlay</title></html>', {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (url.pathname === '/stream/getSources') {
      return Response.json({
        sources: { file: 'https://cdn.watching.onl/anime/example/master.m3u8' },
        tracks: [{ file: 'https://cdn.watching.onl/anime/example/en.vtt', label: 'English' }],
        intro: { start: 10, end: 20 },
      });
    }
    return new Response('unexpected', { status: 500 });
  };

  const response = await worker.fetch(
    await signedResolverRequest('https://megaplay.buzz/stream/s-2/406639/sub?s=bcdn'),
    environment(),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.m3u8, 'https://cdn.watching.onl/anime/example/master.m3u8');
  assert.equal(body.tracks.length, 1);
});

test('rejects unsigned and non-MegaPlay resolver requests', async () => {
  const unsigned = await worker.fetch(
    new Request('https://proxy.example/resolve?url=https%3A%2F%2Fmegaplay.buzz%2Fstream%2F1'),
    environment(),
  );
  assert.equal(unsigned.status, 401);

  const signedWrongHost = await signedResolverRequest('https://cdn.watching.onl/master.m3u8');
  const wrongHost = await worker.fetch(signedWrongHost, environment());
  assert.equal(wrongHost.status, 403);
});
