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
    APPROVED_EMBED_HOSTS: 'megaplay.buzz,*.megaplay.buzz',
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

test('normalizes image-hosted TS and removes stale representation headers', async () => {
  const prefix = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const media = new Uint8Array(188 * 4);
  for (let i = 0; i < media.length; i += 188) media.set([0x47, 0x40, 0, 0x10], i);
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.get('Range'), null);
    return new Response(Uint8Array.from([...prefix, ...media]), {
      headers: { 'content-type': 'image/png', 'content-length': String(prefix.length + media.length),
        'accept-ranges': 'bytes', etag: 'original' },
    });
  };
  const signed = await signedRequest('https://cdn.example/segment.image');
  const request = new Request(signed, { headers: new Headers(signed.headers) });
  request.headers.set('Range', 'bytes=0-');
  const response = await worker.fetch(request, environment());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp2t');
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('accept-ranges'), 'none');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), media);
});

test('preserves byte ranges for ordinary media', async () => {
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.get('Range'), 'bytes=100-103');
    return new Response(Uint8Array.from([1, 2, 3, 4]), { status: 206,
      headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 100-103/1000' } });
  };
  const request = await signedRequest('https://cdn.example/video.mp4');
  request.headers.set('Range', 'bytes=100-103');
  const response = await worker.fetch(request, environment());
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 100-103/1000');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from([1, 2, 3, 4]));
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

test('blocks local addresses but accepts HMAC-authorized public media hosts', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('media', {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  };

  const privateResponse = await worker.fetch(
    await signedRequest('https://127.0.0.1/video.ts'),
    environment({ APPROVED_STREAM_HOSTS: '127.0.0.1' }),
  );
  assert.equal(privateResponse.status, 403);

  const dynamicCdnResponse = await worker.fetch(
    await signedRequest('https://brand-new-cdn.example/video.ts'),
    environment(),
  );
  assert.equal(dynamicCdnResponse.status, 200);
  assert.equal(calls, 1);
});

test('rejects redirects to unsafe destinations', async () => {
  globalThis.fetch = async () => new Response(null, {
    status: 302,
    headers: { Location: 'https://127.0.0.1/private.ts' },
  });
  const response = await worker.fetch(
    await signedRequest('https://cdn.watching.onl/master.m3u8'),
    environment(),
  );
  assert.equal(response.status, 502);
});

test('follows redirects to newly discovered public media hosts', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://future-cdn.example/video.ts' },
      });
    }
    return new Response('media', {
      headers: { 'Content-Type': 'video/mp2t' },
    });
  };
  const response = await worker.fetch(
    await signedRequest('https://cdn.watching.onl/video.ts'),
    environment(),
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
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

test('rewrites newly discovered cross-host HLS children', async () => {
  globalThis.fetch = async () => new Response(
    '#EXTM3U\nhttps://future-cdn.example/media/segment-1.ts\n',
    { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } },
  );
  const response = await worker.fetch(
    await signedRequest('https://cdn.watching.onl/path/quality.m3u8'),
    environment(),
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /url=https%3A%2F%2Ffuture-cdn\.example%2Fmedia%2Fsegment-1\.ts/);
});

test('accepts rotating lostproject media CDN subdomains', async () => {
  globalThis.fetch = async () => new Response('#EXTM3U\n#EXT-X-ENDLIST\n', {
    status: 200,
    headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
  });

  const response = await worker.fetch(
    await signedRequest('https://1oe.lostproject.club/anime/master.m3u8'),
    environment(),
  );
  assert.equal(response.status, 200);
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
        sources: { file: 'https://future-media.example/anime/example/master.m3u8' },
        tracks: [{ file: 'https://future-captions.example/anime/example/en.vtt', label: 'English' }],
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
  assert.equal(body.m3u8, 'https://future-media.example/anime/example/master.m3u8');
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

test('resolves encrypted recent uploads through the new endpoint, preserving the server parameter', async () => {
  const paths = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname.startsWith('/stream/s-2/')) {
      return new Response('<title>File 179446 - MegaPlay</title>');
    }
    assert.equal(url.searchParams.get('id'), '179446');
    assert.equal(url.searchParams.get('s'), 'bcdn');
    if (url.pathname === '/stream/getSources') return Response.json({ enc: 'encrypted-source' });
    assert.equal(url.pathname, '/stream/getSourcesNew');
    return Response.json({ sources: { file: 'https://ncdn.imgnex.top/anime/master.m3u8' },
      tracks: [{ file: 'https://cdn.imgnex.top/en.vtt', label: 'English' }] });
  };
  const response = await worker.fetch(
    await signedResolverRequest('https://megaplay.buzz/stream/s-2/694644/sub?s=bcdn'), environment(),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.m3u8, 'https://ncdn.imgnex.top/anime/master.m3u8');
  assert.equal(body.tracks.length, 1);
  assert.equal(paths.length, 3);
});

const qualityMaster = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\n1080.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=854x480\n480.m3u8\n';

function qualityResponses(statusForSegment) {
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    assert.notEqual(url.hostname, '127.0.0.1');
    if (url.pathname.endsWith('/master.m3u8')) return new Response(qualityMaster);
    if (url.pathname.endsWith('.m3u8')) {
      assert.equal(options.headers.get('Range'), null);
      const name = url.pathname.split('/').pop().replace('.m3u8', '.ts');
      return new Response(`#EXTM3U\n#EXTINF:8,\n${name}\n#EXT-X-ENDLIST\n`);
    }
    assert.equal(options.headers.get('Range'), 'bytes=0-0');
    return new Response('media', { status: statusForSegment(url) });
  };
}

test('MHA episode 10: excludes 720p/480p with missing segments while keeping signed 1080p', async () => {
  qualityResponses(url => url.pathname.endsWith('1080.ts') ? 206 : url.pathname.endsWith('720.ts') ? 404 : 410);
  const response = await worker.fetch(await signedRequest('https://cdn.example/sub/master.m3u8'), environment());
  assert.equal(response.status, 200);
  const manifest = await response.text();
  assert.match(manifest, /RESOLUTION=1920x1080/);
  assert.doesNotMatch(manifest, /1280x720|854x480/);
  const child = new URL(manifest.split('\n').find(line => line.startsWith('https:')));
  assert.equal(child.searchParams.get('url'), 'https://cdn.example/sub/1080.m3u8');
  assert.equal(child.searchParams.get('sig'), await testHelpers.signTarget(secret,
    child.searchParams.get('url'), child.searchParams.get('referer'), Number(child.searchParams.get('exp'))));
});

test('healthy quality choices and transient failures remain advertised', async () => {
  qualityResponses(url => url.pathname.endsWith('480.ts') ? 503 : 206);
  const response = await worker.fetch(await signedRequest('https://cdn.example/master.m3u8'), environment());
  const manifest = await response.text();
  assert.match(manifest, /1920x1080/);
  assert.match(manifest, /1280x720/);
  assert.match(manifest, /854x480/);
});

test('all missing qualities return an error rather than a playable-looking empty master', async () => {
  qualityResponses(() => 404);
  const response = await worker.fetch(await signedRequest('https://cdn.example/master.m3u8'), environment());
  assert.equal(response.status, 502);
});

test('quality health checks never follow private redirects', async () => {
  const calls = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    calls.push(url.hostname);
    if (url.pathname.endsWith('/master.m3u8')) return new Response(qualityMaster);
    return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } });
  };
  const response = await worker.fetch(await signedRequest('https://cdn.example/master.m3u8'), environment());
  assert.equal(response.status, 200);
  assert.ok(calls.every(host => host === 'cdn.example'));
});

for (const legacy of [{ sources: [], enc: 'cipher' }, { sources: 'cipher' }, { sources: [{ file: 'cipher' }] }, null]) {
  test(`resolver adapts unusable or retired sources: ${JSON.stringify(legacy)}`, async () => {
    let count = 0;
    globalThis.fetch = async input => {
      count++;
      const url = new URL(String(input));
      if (url.pathname.startsWith('/stream/s-2/')) return new Response('<title>File 146530</title>');
      if (url.pathname === '/stream/getSources') return legacy == null
        ? new Response('gone', { status: 410 })
        : Response.json({ ...legacy, tracks: [{ file: 'https://cdn.example/en.vtt' }] });
      assert.equal(url.pathname, '/stream/getSourcesNew');
      assert.equal(url.searchParams.get('s'), 'bcdn');
      return Response.json({ sources: [{ file: 'cipher' }, { url: 'https://cdn.example/master.m3u8' }] });
    };
    const response = await worker.fetch(await signedResolverRequest('https://megaplay.buzz/stream/s-2/6219/sub?s=bcdn'), environment());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.m3u8, 'https://cdn.example/master.m3u8');
    assert.equal(body.tracks.length, legacy == null ? 0 : 1);
    assert.equal(count, 3);
  });
}
