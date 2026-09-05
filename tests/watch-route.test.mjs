import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './load-ts.mjs';

const source = { server: 'working', type: 'sub', url: 'https://media.example/stream.m3u8', m3u8: 'https://media.example/stream.m3u8' };
const data = { episode: { number: '1' }, servers: [], sources: [source] };
const params = { params: Promise.resolve({ slug: 'example' }) };
function route(overrides = {}) {
  return loadTs('src/app/api/watch/[slug]/route.ts', {
    '@/lib/scrapers/watch.scraper': {},
    '@/lib/providers/waterfall': { hasPlayableWatchData: d => d?.sources?.length > 0, waterfallWatch: async () => data },
    '@/lib/cache': { cacheGet: async () => undefined, cacheSet: async () => {}, getOrSet: async (_k, f) => f() },
    '@/lib/proxy-security': { withFreshProxyUrls: d => d },
    '@/lib/watch-recovery': { WATCH_TTL: 60, watchCacheKey: () => 'watch:v2:example:1', recoverWatch: async () => ({ ok: true, data }) },
    '@/lib/media-health': { createSourceProbe: () => async () => false },
    ...overrides,
  }).GET;
}

test('public recovery returns fresh JSON and cannot be cached by the browser', async () => {
  const get = route({ '@/lib/cache': { getOrSet: () => assert.fail('normal cache must not run'), cacheGet: () => assert.fail('normal cache must not run') } });
  const result = await get(new Request('https://api.example/api/watch/example?ep=01&recover=1'), params);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal((await result.json()).data.sources[0].server, 'working');
});

test('admin cache bypass stays protected even with recover=1', async () => {
  const result = await route()(new Request('https://api.example/api/watch/example?recover=1&refresh=1'), params);
  assert.equal(result.status, 403);
});

test('recovery failures preserve 503 and retry-after without stale media', async () => {
  const get = route({ '@/lib/watch-recovery': { recoverWatch: async () => ({ ok: false, status: 503, message: 'unavailable' }) } });
  const result = await get(new Request('https://api.example/api/watch/example?recover=1'), params);
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('retry-after'), '30');
  assert.equal((await result.json()).ok, false);
});

test('normal watch cache uses short TTL and explicitly disables stale fallback', async () => {
  const get = route({ '@/lib/cache': { getOrSet: async (_key, _load, ttl, refresh, allowStale) => {
    assert.equal(ttl, 60); assert.equal(refresh, false); assert.equal(allowStale, false); return data;
  } } });
  const result = await get(new Request('https://api.example/api/watch/example?stream=false'), params);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
});

test('SSE excludes a blocked primary source and emits alternate media before done', async () => {
  const get = route({ '@/lib/scrapers/watch.scraper': { scrapeWatchStream: async function* () {
    yield { type: 'episode', episode: data.episode };
    yield { type: 'source', source: { ...source, server: 'blocked' } };
    yield { type: 'done' };
  } } });
  const result = await get(new Request('https://api.example/api/watch/example'), params);
  const events = (await result.text()).trim().split('\n\n').map(s => JSON.parse(s.slice(6)));
  assert.deepEqual(events.filter(e => e.type === 'source').map(e => e.source.server), ['working']);
  assert.equal(events.at(-1).type, 'done');
});
