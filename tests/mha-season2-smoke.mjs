// Read-only live verification. Signed URLs are kept in memory, never logged.
import assert from 'node:assert/strict';
const base = 'https://anikoto-api-teramoto-danish.vercel.app';
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok, `HTTP ${response.status} from ${new URL(url).host}`);
  return response;
}
for (const ep of [21, 22, 23]) {
  const result = await (await get(`${base}/api/watch/my-hero-academia-2-l3eyd?ep=${ep}&stream=false`)).json();
  assert.ok(result.data?.sources?.length, `episode ${ep}: missing sources`);
  const sources = [...new Map(result.data.sources.map(s => [s.type, s])).values()];
  for (const source of sources) {
    let url = source.proxyUrl || source.m3u8;
    let playlist = await (await get(url)).text();
    assert.ok(playlist.startsWith('#EXTM3U'));
    const children = text => text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    const variants = playlist.includes('#EXT-X-STREAM-INF') ? children(playlist).map(s => new URL(s, url).href) : [url];
    for (const [quality, variant] of variants.entries()) {
      playlist = await (await get(variant)).text();
      assert.ok(playlist.includes('#EXT-X-ENDLIST'), 'expected complete VOD');
      const segments = children(playlist);
      const indexes = [...new Set([0, Math.floor(segments.length / 2), segments.length - 1])];
      // Simultaneous reads exercise playback/download contention.
      const sizes = await Promise.all(indexes.map(async index => {
        const bytes = new Uint8Array(await (await get(new URL(segments[index], variant))).arrayBuffer());
        assert.ok(bytes.length > 188, `episode ${ep}: empty segment ${index}`);
        return bytes.length;
      }));
      console.log(JSON.stringify({ ep, audio: source.type, quality, segments: segments.length, sampled: indexes, bytes: sizes }));
    }
  }
}
