import {
  buildSignedProxyUrl,
  parseApprovedProxyTarget,
  verifyProxySignature,
} from '@/lib/proxy-security';

export const dynamic = 'force-dynamic';

const MAX_REDIRECTS = 5;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function jsonError(message: string, status: number) {
  return Response.json(
    { ok: false, message },
    { status, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

function isRedirect(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchApprovedTarget(target: URL, headers: Headers) {
  let current = target;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(current, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    if (!isRedirect(response.status)) return { response, finalUrl: current };
    const location = response.headers.get('location');
    const redirected = location ? parseApprovedProxyTarget(new URL(location, current).toString()) : null;
    if (!redirected) throw new Error('The upstream redirect destination is not approved.');
    current = redirected;
  }
  throw new Error('The upstream returned too many redirects.');
}

async function readTextWithLimit(response: Response, maximumBytes: number) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maximumBytes) throw new Error('The manifest is too large.');
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error('The manifest is too large.');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function normalizeManifestUrl(value: string, manifestUrl: URL) {
  const resolved = new URL(value, manifestUrl);
  const host = resolved.hostname.toLowerCase();
  if (host.endsWith('.buzz') || host.endsWith('.click')) resolved.host = manifestUrl.host;
  return resolved.toString();
}

function responseHeaders(contentType: string, cacheControl: string) {
  return new Headers({
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  if (!verifyProxySignature(requestUrl.searchParams)) {
    return jsonError('The proxy URL is invalid or has expired.', 401);
  }

  const target = parseApprovedProxyTarget(requestUrl.searchParams.get('url') || '');
  if (!target) return jsonError('The streaming destination is not approved.', 403);

  const referer = requestUrl.searchParams.get('referer') || '';
  const expiresAt = Number(requestUrl.searchParams.get('exp'));
  const upstreamHeaders = new Headers({
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36',
  });
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      if (refererUrl.protocol !== 'https:') return jsonError('The signed referer is malformed.', 400);
      upstreamHeaders.set('Referer', refererUrl.toString());
      upstreamHeaders.set('Origin', refererUrl.origin);
    } catch {
      return jsonError('The signed referer is malformed.', 400);
    }
  }
  const range = request.headers.get('range');
  if (range) upstreamHeaders.set('Range', range);

  try {
    const { response: upstream, finalUrl } = await fetchApprovedTarget(target, upstreamHeaders);
    if (!upstream.ok) return jsonError(`The upstream returned HTTP ${upstream.status}.`, upstream.status);

    const contentType = upstream.headers.get('content-type') || '';
    const isManifest = /\.m3u8(?:$|[?#])/i.test(finalUrl.toString()) || contentType.toLowerCase().includes('mpegurl');
    const isSubtitle = /\.(?:vtt|srt|ass)(?:$|[?#])/i.test(finalUrl.toString()) || contentType.toLowerCase().includes('vtt');

    if (isManifest) {
      const manifest = await readTextWithLimit(upstream, MAX_MANIFEST_BYTES);
      const proxyBase = `${requestUrl.origin}/api/proxy`;
      const proxyChild = (value: string) => buildSignedProxyUrl(
        proxyBase,
        normalizeManifestUrl(value, finalUrl),
        referer,
        expiresAt,
      );
      const rewritten = manifest.split(/\r?\n/).map((line) => {
        let result = line.replace(/URI=["']([^"']+)["']/g, (_match, uri: string) => `URI="${proxyChild(uri)}"`);
        const trimmed = result.trim();
        if (trimmed && !trimmed.startsWith('#')) result = proxyChild(trimmed);
        return result;
      }).join('\n');
      return new Response(rewritten, {
        status: upstream.status,
        headers: responseHeaders('application/vnd.apple.mpegurl', 'private, no-store'),
      });
    }

    const headers = responseHeaders(
      isSubtitle ? 'text/vtt; charset=utf-8' : contentType || 'application/octet-stream',
      isSubtitle ? 'public, max-age=3600' : 'public, max-age=3600, immutable',
    );
    for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    console.error('[Proxy]', error instanceof Error ? error.message : 'Unknown upstream error');
    return jsonError('The streaming source could not be reached.', 502);
  }
}
