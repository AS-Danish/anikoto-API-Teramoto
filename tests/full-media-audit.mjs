// Opt-in full transfer audit. URLs remain in memory; local manifest uses only
// local filenames. Not a production downloader.
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const slug = process.argv[2];
const ep = Number(process.argv[3]);
assert.ok(/^[a-z0-9-]+$/.test(slug) && ep > 0, 'provide slug and episode');
const audio = process.argv[4] || 'sub';
const out = `test/media-audit-${slug}-${ep}-${audio}`;
await mkdir(out, { recursive: true });
async function get(url) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (r.ok) return r;
    const detail = (await r.text()).replace(/https?:\/\/[^\s"<>]+/g, '<url>').slice(0, 180);
    if (attempt >= 2) throw new Error(`HTTP ${r.status}: ${detail}`);
    await new Promise(r => setTimeout(r, 1000));
  }
}
let data = await (await get(`https://anikoto-api-teramoto-danish.vercel.app/api/watch/${slug}?ep=${ep}&stream=false`)).json();
if (!data.data.sources.some(s => s.type === audio)) {
  data = await (await get(`https://anikoto-api-teramoto-danish.vercel.app/api/watch/${slug}?ep=${ep}&stream=false&recover=1`)).json();
}
console.log(JSON.stringify({ sources: data.data.sources.map(s => ({ type: s.type, server: s.server })) }));
const source = data.data.sources.filter(s => s.type === audio)[Number(process.argv[5] || 0)];
assert.ok(source, 'requested audio unavailable');
let url = source.proxyUrl || source.m3u8;
let playlist;
for (let depth = 0; depth < 4; depth++) {
  playlist = await (await get(url)).text();
  assert.ok(playlist.startsWith('#EXTM3U'));
  if (!playlist.includes('#EXT-X-STREAM-INF')) break;
  url = new URL(playlist.split(/\r?\n/).find(l => l.trim() && !l.startsWith('#')), url).href;
}
assert.ok(playlist.includes('#EXT-X-ENDLIST'));
assert.ok(!/#EXT-X-(KEY|MAP|BYTERANGE)/.test(playlist), 'this audit currently expects plain TS');
const lines = playlist.split(/\r?\n/);
const segments = lines.map((line, index) => ({ line: line.trim(), index })).filter(s => s.line && !s.line.startsWith('#'));
let cursor = 0, completed = 0, totalBytes = 0;
const anomalies = [];
let inspected = false;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (cursor < segments.length) {
    const n = cursor++;
    const segment = segments[n];
    const segmentUrl = new URL(segment.line, url);
    const response = await get(segmentUrl);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let badPackets = 0;
    for (let p = 0; p < bytes.length; p += 188) if (bytes[p] !== 0x47) badPackets++;
    if (badPackets || bytes.length % 188) {
      const anomaly = { segment: n, bytes: bytes.length, badPackets, remainder: bytes.length % 188, prefix: [...bytes.slice(0, 12)] };
      anomalies.push(anomaly);
      if (!inspected) {
        inspected = true;
        const target = segmentUrl.searchParams.get('url');
        const referer = segmentUrl.searchParams.get('referer');
        const upstream = await fetch(target, { headers: { Referer: referer, Origin: new URL(referer).origin, 'Accept-Encoding': 'identity', 'User-Agent': 'Mozilla/5.0' } });
        const raw = new Uint8Array(await upstream.arrayBuffer());
        const diagnosticHeaders = r => Object.fromEntries(['content-length','content-type','content-encoding','content-range'].map(k=>[k,r.headers.get(k)]));
        console.log(JSON.stringify({ anomaly, proxyHeaders: diagnosticHeaders(response), upstreamHeaders: diagnosticHeaders(upstream), upstreamBytes: raw.length, upstreamPrefix: [...raw.slice(0,8)] }));
      }
    }
    const name = `${String(n).padStart(4, '0')}.ts`;
    await writeFile(`${out}/${name}`, bytes);
    lines[segment.index] = name;
    totalBytes += bytes.length;
    if (++completed % 40 === 0) console.log(JSON.stringify({ completed, total: segments.length, totalBytes }));
  }
}));
await writeFile(`${out}/local.m3u8`, lines.join('\n'));
await writeFile(`${out}/audit.json`, JSON.stringify({ slug, ep, audio, segments: segments.length, totalBytes, anomalies }, null, 2));
console.log(JSON.stringify({ output: out, segments: segments.length, totalBytes, anomalies: anomalies.length }));
