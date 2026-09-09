import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './load-ts.mjs';

const embed = 'https://megacloud.blog/embed-2/v3/e-1/abc';
const nonce = 'a'.repeat(48);
test('decrypts string ciphertext and refreshes a rotated key once', async () => {
  const calls = [];
  const responses = [
    `<html>${nonce}</html>`, { encrypted: true, sources: 'encrypted-string', tracks: [] },
    { mega: 'old-key' }, { error: 'bad key' }, { mega: 'new-key' },
    JSON.stringify([{ file: 'https://cdn.example/video.m3u8' }], null, 2),
  ];
  const { extractMegacloud } = loadTs('src/lib/extractors.ts', { axios: { get: async url => {
    calls.push(new URL(url));
    assert.ok(responses.length);
    return { data: responses.shift() };
  } } });
  assert.equal((await extractMegacloud(embed)).m3u8, 'https://cdn.example/video.m3u8');
  const decrypts = calls.filter(url => url.hostname === 'megacloud-api-nine.vercel.app');
  assert.equal(decrypts.length, 2);
  assert.deepEqual(decrypts.map(url => url.searchParams.get('secret')), ['old-key', 'new-key']);
  assert.ok(decrypts.every(url => url.searchParams.get('encrypted_data') === 'encrypted-string'));
});

test('unchanged key stops recovery instead of retrying forever', async () => {
  const responses = [`<html>${nonce}</html>`, { sources: 'cipher' }, { mega: 'same' }, {}, { mega: 'same' }];
  const { extractMegacloud } = loadTs('src/lib/extractors.ts', { axios: { get: async () => {
    assert.ok(responses.length);
    return { data: responses.shift() };
  } } });
  assert.equal(await extractMegacloud(embed), null);
  assert.equal(responses.length, 0);
});

test('valid plain source marked encrypted is used without key requests', async () => {
  const responses = [`<html>${nonce}</html>`, { encrypted: true, sources: { file: 'https://cdn.example/video.m3u8' } }];
  const { extractMegacloud } = loadTs('src/lib/extractors.ts', { axios: { get: async () => {
    assert.ok(responses.length);
    return { data: responses.shift() };
  } } });
  assert.equal((await extractMegacloud(embed)).m3u8, 'https://cdn.example/video.m3u8');
  assert.equal(responses.length, 0);
});
