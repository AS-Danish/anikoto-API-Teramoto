import axios from 'axios';
import { DEFAULT_HEADERS } from './constants';
import { makeSignedProxyUrlBuilder } from './proxy-security';
import { playbackLog, safeHost, safePlaybackError } from './playback-diagnostics';
import { encryptedSourceValue, sourceMediaUrl } from './source-payload';

export interface SubtitleTrack {
  file: string;
  label?: string;
  kind?: string;
  default?: boolean;
}

export interface IntroOutro {
  start: number;
  end: number;
}

export interface ExtractedStream {
  m3u8: string;
  referer: string;
  tracks: SubtitleTrack[];
  intro?: IntroOutro;
  outro?: IntroOutro;
}

type WorkerResolveResponse = {
  ok?: boolean;
  m3u8?: string;
  referer?: string;
  tracks?: SubtitleTrack[];
  intro?: IntroOutro;
  outro?: IntroOutro;
};

/**
 * Resolve an embed through the signed Cloudflare Worker when the video host
 * rejects Vercel's data-centre IP. The same allow-list, expiry and HMAC used by
 * the media proxy protect this endpoint, so it cannot become an open proxy.
 */
export async function extractStreamViaWorker(
  embedUrl: string,
  parentReferer: string,
  requestId?: string,
): Promise<ExtractedStream | null> {
  const startedAt = Date.now();
  try {
    const signedProxyUrl = makeSignedProxyUrlBuilder()(embedUrl, parentReferer);
    const resolverUrl = new URL(signedProxyUrl);
    resolverUrl.pathname = '/resolve';
    playbackLog(requestId || 'untracked', 'worker.resolve_request', {
      workerHost: resolverUrl.hostname,
      embedHost: safeHost(embedUrl),
    });
    const { data, status, headers } = await axios.get<WorkerResolveResponse>(resolverUrl.toString(), {
      headers: requestId ? { 'X-Playback-Request-Id': requestId } : undefined,
      timeout: 12_000,
    });
    if (data?.ok !== true || typeof data.m3u8 !== 'string' || !data.m3u8) {
      playbackLog(requestId || 'untracked', 'worker.resolve_invalid_response', {
        workerHost: resolverUrl.hostname,
        embedHost: safeHost(embedUrl),
        status,
        contentType: String(headers['content-type'] || '').slice(0, 100),
        responseOk: data?.ok === true,
        hasMedia: Boolean(data?.m3u8),
        elapsedMs: Date.now() - startedAt,
      }, 'warn');
      return null;
    }
    playbackLog(requestId || 'untracked', 'worker.resolve_succeeded', {
      workerHost: resolverUrl.hostname,
      embedHost: safeHost(embedUrl),
      mediaHost: safeHost(data.m3u8),
      captionCount: Array.isArray(data.tracks) ? data.tracks.length : 0,
      elapsedMs: Date.now() - startedAt,
    });
    return {
      m3u8: data.m3u8,
      referer: typeof data.referer === 'string' && data.referer
        ? data.referer
        : new URL(embedUrl).origin + '/',
      tracks: Array.isArray(data.tracks) ? data.tracks : [],
      intro: data.intro,
      outro: data.outro,
    };
  } catch (error) {
    playbackLog(requestId || 'untracked', 'worker.resolve_failed', {
      embedHost: safeHost(embedUrl),
      elapsedMs: Date.now() - startedAt,
      error: safePlaybackError(error),
    }, 'warn');
    return null;
  }
}

let _keysCache: Record<string, string> | null = null;
let _keysCacheAt = 0;
const KEYS_CACHE_MS = 15 * 60 * 1000;

let _keysPending: Promise<Record<string, string>> | null = null;
async function getMegacloudKeys(refresh = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (!refresh && _keysCache && now - _keysCacheAt < KEYS_CACHE_MS) return _keysCache;
  if (_keysPending) return _keysPending;
  _keysPending = axios.get<Record<string, string>>(
    'https://raw.githubusercontent.com/yogesh-hacker/MegacloudKeys/refs/heads/main/keys.json',
    { timeout: 5000 }
  ).then(({ data }) => {
    if (typeof data?.mega !== 'string' || !data.mega) throw new Error('Missing MegaCloud key');
    _keysCache = data;
    _keysCacheAt = Date.now();
    return data;
  }).finally(() => { _keysPending = null; });
  return _keysPending;
}

async function _doMegaplay(
  host: string,
  html: string,
  referer: string,
  embedUrl: string,
): Promise<ExtractedStream | null> {
  const match = html.match(/<title>\s*File\s+([0-9]+)/i);
  if (!match) return null;

  const id = match[1];
  const sourcesUrl = new URL(`https://${host}/stream/getSources`);
  sourcesUrl.searchParams.set('id', id);
  const server = new URL(embedUrl).searchParams.get('s');
  if (server) sourcesUrl.searchParams.set('s', server);
  const options = {
    headers: { ...DEFAULT_HEADERS, 'X-Requested-With': 'XMLHttpRequest', Referer: referer },
    timeout: 10000,
  };
  let data;
  try {
    ({ data } = await axios.get(sourcesUrl.toString(), options));
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status !== 404 && status !== 410) throw error;
  }
  // Switch endpoints whenever the old response has no usable media, including
  // encrypted strings, empty source arrays, and retired legacy endpoints.
  if (!sourceMediaUrl(data?.sources)) {
    sourcesUrl.pathname = '/stream/getSourcesNew';
    const next = await axios.get(sourcesUrl.toString(), options);
    data = { ...data, ...next.data };
  }

  let m3u8 = sourceMediaUrl(data?.sources);
  const tracks: SubtitleTrack[] = Array.isArray(data?.tracks) ? data.tracks : [];
  
  const intro = data?.intro && typeof data.intro.start === 'number' && typeof data.intro.end === 'number'
    ? { start: data.intro.start, end: data.intro.end }
    : undefined;
  const outro = data?.outro && typeof data.outro.start === 'number' && typeof data.outro.end === 'number'
    ? { start: data.outro.start, end: data.outro.end }
    : undefined;

  if (m3u8 && m3u8.includes('mewstream.buzz')) {
    let replacementHost = '1oe.lostproject.club';
    const firstTrack = tracks.find(t => t.file && !t.file.includes('mewstream.buzz'));
    if (firstTrack) {
      try {
        replacementHost = new URL(firstTrack.file).host;
      } catch (_) {}
    }
    try {
      const parsedM3u8 = new URL(m3u8);
      parsedM3u8.host = replacementHost;
      m3u8 = parsedM3u8.toString();
    } catch (_) {}
  }

  return m3u8 ? { m3u8, referer, tracks, intro, outro } : null;
}

async function _doMegacloud(
  embedUrl: string,
  html: string,
  referer: string
): Promise<ExtractedStream | null> {
  const origin = new URL(embedUrl).origin;

  const match1 = html.match(/\b[a-zA-Z0-9]{48}\b/);
  const match2 = html.match(/\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b/);
  const nonce = match1?.[0] || (match2 ? match2[1] + match2[2] + match2[3] : null);

  if (!nonce) return null;

  const sId =
    embedUrl.split('/e-1/')[1]?.split('?')[0] ??
    embedUrl.split('/').pop()?.split('?')[0];
  const sourcesUrl = `${origin}/embed-2/v3/e-1/getSources?id=${sId}&_k=${nonce}`;

  const { data } = await axios.get(sourcesUrl, {
    headers: {
      ...DEFAULT_HEADERS,
      Accept: '*/*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: embedUrl, // Fix: Referer of getSources must be embedUrl
    },
    timeout: 10000,
  });

  const tracks: SubtitleTrack[] = Array.isArray(data?.tracks) ? data.tracks : [];
  
  const intro = data?.intro && typeof data.intro.start === 'number' && typeof data.intro.end === 'number'
    ? { start: data.intro.start, end: data.intro.end }
    : undefined;
  const outro = data?.outro && typeof data.outro.start === 'number' && typeof data.outro.end === 'number'
    ? { start: data.outro.start, end: data.outro.end }
    : undefined;

  const streamReferer = origin + '/'; // Referer for CDN stream is megacloud.tv origin

  const plain = sourceMediaUrl(data?.sources);
  if (plain) {
    return { m3u8: plain, referer: streamReferer, tracks, intro, outro };
  }
  const encrypted = encryptedSourceValue(data?.sources) || encryptedSourceValue(data?.enc);
  if (!encrypted) return null;
  let previousKey = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const keys = await getMegacloudKeys(attempt > 0);
    const secret = keys.mega;
    if (secret === previousKey) break;
    previousKey = secret;
    const decryptUrl = new URL('https://megacloud-api-nine.vercel.app/');
    decryptUrl.searchParams.set('encrypted_data', encrypted);
    decryptUrl.searchParams.set('nonce', nonce);
    decryptUrl.searchParams.set('secret', secret);
    try {
      const { data: decrypted } = await axios.get(decryptUrl.toString(), { timeout: 5000 });
      const m3u8 = sourceMediaUrl(decrypted);
      if (m3u8) return { m3u8, referer: streamReferer, tracks, intro, outro };
    } catch {
      // One key refresh handles rotations; never loop indefinitely or log keys.
    }
  }
  return null;
}

export async function extractVidstream(
  embedUrl: string,
  referer: string
): Promise<ExtractedStream | null> {
  try {
    let parentOrigin = referer;
    try {
      parentOrigin = new URL(referer).origin + '/';
    } catch (_) {}

    const { data: html } = await axios.get<string>(embedUrl, {
      headers: { ...DEFAULT_HEADERS, Referer: parentOrigin },
      timeout: 8000,
    });

    const epIdMatch = html.match(/data-ep-id=["'](\d+)["']/);
    const typeMatch = html.match(/type:\s*'(\w+)'/);
    const domain2Match = html.match(/domain2_url:\s*'([^']+)'/);

    if (!epIdMatch || !typeMatch || !domain2Match) return null;

    const epId = epIdMatch[1];
    const epType = typeMatch[1];
    const domain2 = domain2Match[1].trim();

    const saveDataUrl = `${domain2}/save_data.php?id=${epId}-${epType}`;
    const { data } = await axios.get(saveDataUrl, {
      headers: { ...DEFAULT_HEADERS, Referer: embedUrl }, // Fix: Referer of save_data.php must be embedUrl
      timeout: 8000,
    });

    const sources = data?.data?.sources ?? [];
    const tracks: SubtitleTrack[] = data?.data?.tracks ?? [];
    const m3u8 = sources[0]?.url ?? null;

    if (!m3u8) return null;

    return { m3u8, referer: domain2 + '/', tracks };
  } catch (err) {
    console.error('[extractVidstream] Failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function extractMegaplay(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const host = new URL(embedUrl).host;
    const referer = 'https://' + host + '/';
    const { data: html } = await axios.get<string>(embedUrl, {
      headers: { ...DEFAULT_HEADERS, Referer: referer },
      timeout: 10000,
    });
    return await _doMegaplay(host, html, referer, embedUrl);
  } catch (err) {
    console.error('Megaplay extraction failed:', err);
    return null;
  }
}

export async function extractMegacloud(
  embedUrl: string,
  parentReferer?: string
): Promise<ExtractedStream | null> {
  try {
    const origin = new URL(embedUrl).origin;
    let referer = origin + '/';
    if (parentReferer) {
      try {
        referer = new URL(parentReferer).origin + '/';
      } catch (_) {}
    }
    const { data: html } = await axios.get<string>(embedUrl, {
      headers: { ...DEFAULT_HEADERS, Referer: referer },
      timeout: 10000,
    });
    return await _doMegacloud(embedUrl, html, embedUrl); // Use embedUrl as the referer for getSources!
  } catch (err) {
    console.error('Megacloud extraction failed:', err);
    return null;
  }
}

export async function extractStreamUrl(
  embedUrl: string,
  parentReferer?: string
): Promise<ExtractedStream | null> {
  const hostname = new URL(embedUrl).hostname;

  if (
    hostname.includes('megaplay.buzz') ||
    hostname.includes('vidwish.live') ||
    hostname.includes('megacloud.bloggy.click')
  ) {
    const megaplayUrl = embedUrl
      .replace('vidwish.live', 'megaplay.buzz')
      .replace('megacloud.bloggy.click', 'megaplay.buzz');
    return extractMegaplay(megaplayUrl);
  }

  if (hostname.includes('megacloud.blog')) {
    return extractMegacloud(embedUrl, parentReferer);
  }

  if (hostname.includes('vidtube.site')) {
    return extractMegaplay(embedUrl);
  }

  let currentUrl = embedUrl;

  for (let i = 0; i < 2; i++) {
    let html = '';
    try {
      let host = new URL(currentUrl).host;
      let referer = 'https://' + host + '/';
      if (parentReferer) {
        try {
          referer = new URL(parentReferer).origin + '/';
        } catch (_) {}
      }
      let response;

      try {
        response = await axios.get<string>(currentUrl, {
          headers: { ...DEFAULT_HEADERS, Referer: referer },
          timeout: 10000,
        });
      } catch {
        if (currentUrl.includes('vidwish.live') || currentUrl.includes('megacloud.bloggy.click')) {
          const fallbackUrl = currentUrl
            .replace('vidwish.live', 'megaplay.buzz')
            .replace('megacloud.bloggy.click', 'megaplay.buzz');
          host = new URL(fallbackUrl).host;
          referer = 'https://' + host + '/';
          if (parentReferer) {
            try {
              referer = new URL(parentReferer).origin + '/';
            } catch (_) {}
          }
          response = await axios.get<string>(fallbackUrl, {
            headers: { ...DEFAULT_HEADERS, Referer: referer },
            timeout: 10000,
          });
          currentUrl = fallbackUrl;
        } else {
          return null;
        }
      }

      html = response.data;

      const isErrorPage =
        html.includes('Error -') ||
        html.includes('error-container') ||
        html.includes("doesn't exist");
      if (
        isErrorPage &&
        (currentUrl.includes('vidwish.live') || currentUrl.includes('megacloud.bloggy.click'))
      ) {
        const fallbackUrl = currentUrl
          .replace('vidwish.live', 'megaplay.buzz')
          .replace('megacloud.bloggy.click', 'megaplay.buzz');
        host = new URL(fallbackUrl).host;
        referer = 'https://' + host + '/';
        if (parentReferer) {
          try {
            referer = new URL(parentReferer).origin + '/';
          } catch (_) {}
        }
        response = await axios.get<string>(fallbackUrl, {
          headers: { ...DEFAULT_HEADERS, Referer: referer },
          timeout: 10000,
        });
        currentUrl = fallbackUrl;
        html = response.data;
      }

      const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (iframeMatch) {
        const resolved = new URL(iframeMatch[1], currentUrl).toString();
        if (resolved !== currentUrl) {
          currentUrl = resolved;
          continue;
        }
      }

      const finalHost = new URL(currentUrl).hostname;
      const finalReferer = 'https://' + new URL(currentUrl).host + '/';

      if (
        finalHost.includes('megaplay.buzz') ||
        finalHost.includes('vidwish.live') ||
        finalHost.includes('vidtube.site')
      ) {
        return await _doMegaplay(new URL(currentUrl).host, html, finalReferer, currentUrl);
      }
      if (finalHost.includes('megacloud.blog')) {
        return await _doMegacloud(currentUrl, html, currentUrl); // Use currentUrl as referer for getSources!
      }

      return null;
    } catch (err) {
      console.error(`[extractStreamUrl] Failed for ${currentUrl}:`, err);
      return null;
    }
  }

  return null;
}
