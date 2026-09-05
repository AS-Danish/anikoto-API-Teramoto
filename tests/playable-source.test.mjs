import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(
  readFileSync(new URL('../src/lib/playable-source.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const { hasMediaSource } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('an embed alone cannot suppress provider fallback or poison the watch cache', () => {
  assert.equal(hasMediaSource({url: 'https://megaplay.buzz/stream/s-2/2142/sub', m3u8: null}), false);
  assert.equal(hasMediaSource({url: 'https://example.test/embed', proxyUrl: ' '}), false);
});

test('resolved streams, signed proxies and direct video files remain playable candidates', () => {
  for (const source of [
    {m3u8: 'https://media.example/playlist'},
    {proxyUrl: '/api/proxy?url=signed'},
    {url: 'https://media.example/movie.mp4?token=x'},
    {url: 'https://media.example/master.m3u8'},
  ]) assert.equal(hasMediaSource(source), true);
});

test('malformed and non-HTTP sources are rejected', () => {
  for (const source of [null, {}, {m3u8: 1}, {url: 'javascript:movie.mp4'}, {proxyUrl: '//example.test'}]) {
    assert.equal(hasMediaSource(source), false);
  }
});
