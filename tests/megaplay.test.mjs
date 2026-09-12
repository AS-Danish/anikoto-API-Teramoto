import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { loadTs } from './load-ts.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const playerKey = 'i?LMTAx0Q6,:}50U';
const playerIv = "W0;27ToaUpl_P%'c";
const clientScript = `(function(r){"use strict";var E="${playerKey}",C="${playerIv}",P=/\\/segment\\//;})();`;

async function encryptFixture(value) {
  const keyBytes = new Uint8Array(32);
  keyBytes.set(new TextEncoder().encode(playerKey));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: new TextEncoder().encode(playerIv) }, key, new TextEncoder().encode(value),
  );
  return Buffer.from(encrypted).toString('base64url');
}

function extractor(responses) {
  const calls = [];
  const { extractMegaplay } = loadTs('src/lib/extractors.ts', {
    axios: { get: async (url) => {
      calls.push(new URL(url));
      assert.ok(responses.length, 'unexpected extra source request');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return { data: response };
    } },
  });
  return { extractMegaplay, calls };
}

test('recent upload encrypted envelope falls back once and preserves server selection and captions', async () => {
  const tracks = [{ file: 'https://cdn.example/en.vtt', label: 'English' }];
  const { extractMegaplay, calls } = extractor([
    '<title>File 179446 - MegaPlay</title>',
    { enc: 'encrypted-source', tracks },
    { sources: { file: 'https://cdn.example/master.m3u8' }, tracks, intro: { start: 1, end: 20 } },
  ]);
  const result = await extractMegaplay('https://megaplay.buzz/stream/s-2/694644/sub?s=bcdn');
  assert.equal(result.m3u8, 'https://cdn.example/master.m3u8');
  assert.deepEqual(result.tracks, tracks);
  assert.deepEqual(result.intro, { start: 1, end: 20 });
  assert.deepEqual(calls.slice(1).map((url) => url.pathname), ['/stream/getSources', '/stream/getSourcesNew']);
  for (const url of calls.slice(1)) {
    assert.equal(url.searchParams.get('id'), '179446');
    assert.equal(url.searchParams.get('s'), 'bcdn');
  }
});

test('MHA season 3 episode 13 decrypts the current envelope using the linked player client', async () => {
  const encrypted = await encryptFixture(JSON.stringify({ file: 'https://media.example/mha-s3-e13/master.m3u8' }));
  const tracks = [{ file: 'https://cdn.example/en.vtt', label: 'English' }];
  const { extractMegaplay, calls } = extractor([
    '<div data-id="33982"></div><script src="/lib/newclient.min.js?v=4.7"></script>',
    { enc: encrypted, tracks },
    { enc: encrypted, tracks },
    clientScript,
  ]);
  const result = await extractMegaplay('https://megaplay.buzz/stream/s-2/4488/sub?s=tcdn');
  assert.equal(result.m3u8, 'https://media.example/mha-s3-e13/master.m3u8');
  assert.deepEqual(result.tracks, tracks);
  assert.deepEqual(calls.map(url => url.pathname), [
    '/stream/s-2/4488/sub', '/stream/getSources', '/stream/getSourcesNew', '/lib/newclient.min.js',
  ]);
});

for (const legacy of [{ sources: [], enc: 'cipher' }, { sources: 'cipher' }, { sources: [{ file: 'cipher' }] }, { sources: {} }]) {
  test(`adapts source schema ${JSON.stringify(legacy)} and preserves metadata`, async () => {
    const tracks = [{ file: 'https://cdn.example/en.vtt', label: 'English' }];
    const { extractMegaplay, calls } = extractor([
      '<title>File 146530</title>', { ...legacy, tracks },
      { sources: [{ file: 'not-media' }, { url: 'https://cdn.example/video.m3u8' }] },
    ]);
    const result = await extractMegaplay('https://megaplay.buzz/stream/s-2/6219/sub?s=bcdn');
    assert.equal(result.m3u8, 'https://cdn.example/video.m3u8');
    assert.deepEqual(result.tracks, tracks);
    assert.equal(calls.length, 3);
  });
}

test('retired endpoint falls back once; private and encrypted output is never media', async () => {
  const error = Object.assign(new Error('gone'), { response: { status: 410 } });
  const { extractMegaplay, calls } = extractor([
    '<title>File 1</title>', error, { sources: [{ file: 'https://127.0.0.1/private' }, { file: 'cipher' }] },
  ]);
  assert.equal(await extractMegaplay('https://megaplay.buzz/stream/1'), null);
  assert.equal(calls.length, 3);
});

test('legacy sources still resolve without an extra request', async () => {
  const { extractMegaplay, calls } = extractor([
    '<title>File 1 - MegaPlay</title>',
    { sources: { file: 'https://cdn.example/old.m3u8' } },
  ]);
  assert.equal((await extractMegaplay('https://megaplay.buzz/stream/1')).m3u8, 'https://cdn.example/old.m3u8');
  assert.equal(calls.length, 2);
});

test('an empty encrypted fallback is not returned as playable media', async () => {
  const { extractMegaplay, calls } = extractor([
    '<title>File 1 - MegaPlay</title>', { enc: 'encrypted-source' }, { enc: 'still-unavailable' },
  ]);
  assert.equal(await extractMegaplay('https://megaplay.buzz/stream/1'), null);
  assert.equal(calls.length, 3);
});
