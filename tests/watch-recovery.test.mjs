import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './load-ts.mjs';

test('recovery performs a new resolution and updates the normal watch cache', async () => {
  const calls = [];
  const fresh = { sources: [{ m3u8: 'https://cdn.example/fresh.m3u8' }] };
  const { recoverWatch } = loadTs('src/lib/watch-recovery.ts', {
    './cache': {
      getOrSet: async (...args) => { calls.push(args); return args[1](); },
      consumeRateLimit: async () => true,
      cacheSet: async (...args) => calls.push(args),
    },
    './providers/waterfall': { waterfallWatch: async () => fresh },
  });
  const result = await recoverWatch('example', '01', 'test');
  assert.equal(result.data, fresh);
  assert.equal(calls[0][0], 'recovery:watch:v2:example:1');
  assert.deepEqual(calls[0].slice(2), [30, false, false]);
  assert.deepEqual(calls[1], ['watch:v2:example:1', fresh, 60]);
});

test('an unavailable provider returns a cacheable failure, never stale success', async () => {
  const { recoverWatch } = loadTs('src/lib/watch-recovery.ts', {
    './cache': { getOrSet: async (_key, loader) => loader(), consumeRateLimit: async () => true },
    './providers/waterfall': { waterfallWatch: async () => { throw new Error('upstream 403'); } },
  });
  assert.equal((await recoverWatch('example', '1', 'test')).status, 503);
});

test('recovery admission limit prevents another provider request', async () => {
  const { recoverWatch } = loadTs('src/lib/watch-recovery.ts', {
    './cache': { getOrSet: async (_key, loader) => loader(), consumeRateLimit: async () => false },
    './providers/waterfall': { waterfallWatch: async () => { assert.fail('must not fetch'); } },
  });
  assert.equal((await recoverWatch('example', '1', 'test')).status, 429);
});

test('strict cache reads do not fall back to an expired playback result', async () => {
  const { default: cache, getOrSet } = loadTs('src/lib/cache.ts');
  cache.set('__stale__:watch-test', { old: true }, 60);
  await assert.rejects(getOrSet('watch-test', async () => { throw new Error('offline'); }, 30, true, false), /offline/);
  cache.close();
});

test('recovery requests share one loader and cache its failure during cooldown', async () => {
  const { default: cache, getOrSet } = loadTs('src/lib/cache.ts');
  let calls = 0;
  const loader = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return { ok: false }; };
  await Promise.all(Array.from({ length: 8 }, () => getOrSet('recovery-test', loader, 30, false, false)));
  await getOrSet('recovery-test', loader, 30, false, false);
  assert.equal(calls, 1);
  cache.close();
});

test('fallback selects a reachable alternate provider after an HTTP failure', async () => {
  const data = (host) => ({ episode: { number: '1' }, servers: [], sources: [{ url: `https://${host}/master.m3u8`, m3u8: `https://${host}/master.m3u8` }] });
  const { waterfallWatch } = loadTs('src/lib/providers/waterfall.ts', {
    '../scrapers/watch.scraper': { scrapeWatch: async () => data('blocked.test') },
    './consumet.provider': { getConsumetWatch: async () => data('working.test') },
    '../media-health': { createSourceProbe: () => async (s) => s.url.includes('working.test') },
  });
  const result = await waterfallWatch('example', '1');
  assert.equal(result.source, 'consumet');
  assert.equal(result.sources[0].m3u8, 'https://working.test/master.m3u8');
});
