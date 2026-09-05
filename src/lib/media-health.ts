import { parseSafeMediaTarget } from './proxy-security';
import { playbackLog, safeHost } from './playback-diagnostics';
import type { VideoSource } from './scrapers/watch.scraper';

const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

async function playlistText(response: Response) {
  if (!response.body) throw new Error('empty_playlist');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.length;
      if (bytes > MAX_PLAYLIST_BYTES) throw new Error('playlist_too_large');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Check the actual client route, including a variant and its first segment.
 * Never follow a redirect/playlist destination without the proxy's URL checks.
 */
export async function probeMedia(
  value: string,
  referer = '',
  fetcher: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<{ ok: boolean; status?: number; reason?: string }> {
  const signal = AbortSignal.timeout(timeoutMs);
  let status: number | undefined;
  try {
    let next = value;
    for (let depth = 0; depth < 4; depth++) {
      const initial = parseSafeMediaTarget(next);
      if (!initial) throw new Error('unsafe_destination');
      let target: URL = initial;
      let response: Response | undefined;
      for (let redirect = 0; redirect <= 5; redirect++) {
        response = await fetcher(target, {
          headers: {
            Accept: '*/*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36',
            // A segment check must not download an entire video file.
            Range: 'bytes=0-2097151',
            ...(referer ? { Referer: referer, Origin: new URL(referer).origin } : {}),
          },
          cache: 'no-store', redirect: 'manual', signal,
        });
        status = response.status;
        if (![301, 302, 303, 307, 308].includes(status)) break;
        const location: string | null = response.headers.get('location');
        await response.body?.cancel();
        const redirected: URL | null = location ? parseSafeMediaTarget(new URL(location, target).href) : null;
        if (!redirected || redirect === 5) throw new Error('unsafe_or_excessive_redirect');
        target = redirected;
      }
      if (!response?.ok) {
        await response?.body?.cancel();
        return { ok: false, status, reason: 'upstream_http_error' };
      }
      const type = response.headers.get('content-type') || '';
      if (/html|json/i.test(type)) {
        await response.body?.cancel();
        return { ok: false, status, reason: 'not_media' };
      }
      // Proxy URLs carry the real filename in their signed query.
      const mediaUrl = target.searchParams.get('url') || target.href;
      const manifest = /\.m3u8(?:$|[?#])/i.test(mediaUrl) || /mpegurl/i.test(type);
      if (!manifest) {
        const reader = response.body?.getReader();
        const first = await reader?.read();
        await reader?.cancel();
        if (!first?.value?.length) return { ok: false, status, reason: 'empty_media' };
        const prefix = new TextDecoder().decode(first.value.subarray(0, 256)).trimStart();
        if (/^(?:<!doctype|<html|\{)/i.test(prefix)) return { ok: false, status, reason: 'not_media' };
        return { ok: true, status };
      }
      const text = (await playlistText(response)).trimStart();
      if (!text.startsWith('#EXTM3U')) return { ok: false, status, reason: 'invalid_playlist' };
      const child = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
      if (!child) return { ok: false, status, reason: 'empty_playlist' };
      next = new URL(child, target).href;
    }
    return { ok: false, status, reason: 'playlist_nesting_limit' };
  } catch {
    return { ok: false, status, reason: signal.aborted ? 'timeout' : 'unreachable_or_invalid' };
  }
}

/** Request-scoped coalescing: aliases of the same stream are probed only once. */
export function createSourceProbe(requestId: string) {
  const pending = new Map<string, Promise<boolean>>();
  return (source: VideoSource): Promise<boolean> => {
    const proxy = source.proxyUrl?.startsWith('https://') ? source.proxyUrl : undefined;
    const media = source.m3u8 || source.url;
    const value = proxy || media;
    const key = `${value}|${source.referer || ''}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const promise = probeMedia(value, proxy ? '' : source.referer).then((result) => {
      playbackLog(requestId, 'source.health_checked', {
        server: source.server, type: source.type, mediaHost: safeHost(media),
        proxyHost: safeHost(proxy), ...result,
        // Record remaining lifetime, never the URL, token or signature.
        proxyExpiresInSeconds: proxy ? Number(new URL(proxy).searchParams.get('exp')) - Math.floor(Date.now() / 1000) : undefined,
      }, result.ok ? 'info' : 'warn');
      return result.ok;
    });
    pending.set(key, promise);
    return promise;
  };
}
