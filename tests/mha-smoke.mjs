// Opt-in live smoke check; does not persist signed playback URLs.
import assert from 'node:assert/strict';
const episode = process.argv[2] || '10';
const base = 'https://anikoto-api-teramoto-danish.vercel.app';
const response = await fetch(`${base}/api/watch/my-hero-academia-kuzfp?ep=${episode}&stream=false`);
const result = await response.json();
console.log('watch', response.status, result.ok);
assert.equal(result.ok, true);
assert.ok(result.data.sources.length);
const representatives = [...new Map(result.data.sources.map(source => [source.type, source])).values()];
for (const source of representatives) {
  let url = source.proxyUrl;
  for (let depth = 0; depth < 3; depth++) {
    const media = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const bytes = new Uint8Array(await media.arrayBuffer());
    console.log(source.type, depth, media.status, media.headers.get('content-type'), bytes.length);
    assert.ok(media.ok && bytes.length > 0);
    const text = new TextDecoder().decode(bytes);
    if (!text.startsWith('#EXTM3U')) {
      console.log('segment prefix', [...bytes.slice(0, 16)]);
      break;
    }
    if (depth === 0) {
      for (const variant of text.split(/\r?\n/).filter(line => line && !line.startsWith('#'))) {
        const r = await fetch(new URL(variant, url), { headers: { Origin: 'https://luffytvstream.vercel.app' } });
        const playlist = await r.text();
        const segment = playlist.split(/\r?\n/).find(line => line && !line.startsWith('#'));
        console.log('variant', r.status, r.headers.get('access-control-allow-origin'));
        assert.ok(r.ok && segment);
        if (r.ok && segment) {
          const s = await fetch(new URL(segment, variant), { headers: { Origin: 'https://luffytvstream.vercel.app', Range: 'bytes=0-1023' } });
          console.log('variant segment', s.status, s.headers.get('access-control-allow-origin'), (await s.arrayBuffer()).byteLength);
          assert.ok(s.ok, 'An advertised quality has a missing video segment');
        }
      }
    }
    for (const key of text.matchAll(/#EXT-X-KEY:[^\n]*URI="([^"]+)"/g)) {
      const keyResponse = await fetch(new URL(key[1], url));
      console.log('key', keyResponse.status, (await keyResponse.arrayBuffer()).byteLength);
    }
    console.log('manifest tags', text.split(/\r?\n/).filter(line => line.startsWith('#')).slice(0, 8).map(line => line.replace(/URI="[^"]+"/g, 'URI="<redacted>"')));
    const child = text.split(/\r?\n/).find(line => line && !line.startsWith('#'));
    if (!child) break;
    url = new URL(child, url).href;
  }
}
