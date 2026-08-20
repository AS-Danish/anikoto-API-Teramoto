const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36';
const SIGNATURE_VERSION = '1';
const MAX_PROXY_TTL_SECONDS = 6 * 60 * 60;
const CLOCK_SKEW_SECONDS = 30;
const MAX_REDIRECTS = 5;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function splitList(value) {
  return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function allowedCorsOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  return splitList(env.ALLOWED_CORS_ORIGINS).includes(origin) ? origin : false;
}

function corsHeaders(origin) {
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Range',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  });
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function jsonError(message, status, origin, extraHeaders = {}) {
  const headers = corsHeaders(origin);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return Response.json({ error: message }, { status, headers });
}

function signaturePayload(targetUrl, referer, expiresAt) {
  return `${SIGNATURE_VERSION}\n${expiresAt}\n${targetUrl}\n${referer}`;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value) {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  return new Uint8Array(value.match(/.{2}/g).map((pair) => Number.parseInt(pair, 16)));
}

async function importSigningKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signTarget(secret, targetUrl, referer, expiresAt) {
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signaturePayload(targetUrl, referer, expiresAt)),
  );
  return bytesToHex(new Uint8Array(signature));
}

async function verifySignature(searchParams, env) {
  const targetUrl = searchParams.get('url') || '';
  const referer = searchParams.get('referer') || '';
  const signature = hexToBytes(searchParams.get('sig') || '');
  const version = searchParams.get('v') || '';
  const expiresAt = Number(searchParams.get('exp'));
  const now = Math.floor(Date.now() / 1_000);
  if (!targetUrl || !signature || version !== SIGNATURE_VERSION || !Number.isInteger(expiresAt)) return false;
  if (expiresAt < now - CLOCK_SKEW_SECONDS || expiresAt > now + MAX_PROXY_TTL_SECONDS + CLOCK_SKEW_SECONDS) {
    return false;
  }

  const payload = new TextEncoder().encode(signaturePayload(targetUrl, referer, expiresAt));
  const secrets = [env.PROXY_SIGNING_SECRET, env.PROXY_SIGNING_SECRET_PREVIOUS]
    .filter((secret) => typeof secret === 'string' && secret.length >= 32);
  for (const secret of secrets) {
    const key = await importSigningKey(secret);
    if (await crypto.subtle.verify('HMAC', key, signature, payload)) return true;
  }
  return false;
}

async function signedProxyUrl(workerBase, targetUrl, referer, expiresAt, env) {
  const approved = approvedTarget(targetUrl, env);
  if (!approved) throw new Error('Refusing to sign an unapproved manifest destination');
  const normalizedTarget = approved.toString();
  const url = new URL(workerBase);
  url.searchParams.set('url', normalizedTarget);
  url.searchParams.set('exp', String(expiresAt));
  url.searchParams.set('v', SIGNATURE_VERSION);
  url.searchParams.set('sig', await signTarget(env.PROXY_SIGNING_SECRET, normalizedTarget, referer, expiresAt));
  if (referer) url.searchParams.set('referer', referer);
  return url.toString();
}

function ipv4Parts(hostname) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
  const parts = hostname.split('.').map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

function isBlockedIpv4(hostname) {
  const parts = ipv4Parts(hostname);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19));
}

function isBlockedIpv6(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes(':')) return false;
  if (host === '::' || host === '::1') return true;
  if (/^(?:fc|fd)/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host) || /^2001:db8/.test(host)) {
    return true;
  }
  const mapped = host.match(/(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mapped ? isBlockedIpv4(mapped[1]) : false;
}

function isPrivateOrLocalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || host.endsWith('.home.arpa') ||
    isBlockedIpv4(host) || isBlockedIpv6(host);
}

function hostMatches(hostname, pattern) {
  const normalized = pattern.toLowerCase().replace(/\.$/, '');
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === normalized;
}

function approvedTarget(value, env) {
  if (!value || value.length > 8_192) return null;
  try {
    const target = new URL(value);
    const hostname = target.hostname.toLowerCase().replace(/\.$/, '');
    if (target.protocol !== 'https:' || target.username || target.password || isPrivateOrLocalHostname(hostname)) {
      return null;
    }
    if (!splitList(env.APPROVED_STREAM_HOSTS).some((pattern) => hostMatches(hostname, pattern))) return null;
    return target;
  } catch {
    return null;
  }
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchApprovedTarget(target, headers, env) {
  let current = target;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(current, { headers, redirect: 'manual' });
    if (!isRedirect(response.status)) return { response, finalUrl: current };
    const location = response.headers.get('location');
    const redirected = location ? approvedTarget(new URL(location, current).toString(), env) : null;
    if (!redirected) throw new Error('Unapproved upstream redirect');
    current = redirected;
  }
  throw new Error('Too many upstream redirects');
}

async function readTextWithLimit(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maximumBytes) throw new Error('Manifest too large');
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
      throw new Error('Manifest too large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function normalizeManifestUrl(value, manifestUrl) {
  const resolved = new URL(value, manifestUrl);
  const host = resolved.hostname.toLowerCase();
  if (host.endsWith('.buzz') || host.endsWith('.click')) resolved.host = manifestUrl.host;
  return resolved.toString();
}

function proxiedHeaders(origin, contentType, cacheControl) {
  const headers = corsHeaders(origin);
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', cacheControl);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  return headers;
}

async function enforceRateLimits(request, env) {
  if (!env.BURST_RATE_LIMITER || !env.SUSTAINED_RATE_LIMITER) return false;
  const clientKey = request.headers.get('CF-Connecting-IP') || 'unknown-client';
  const [burst, sustained] = await Promise.all([
    env.BURST_RATE_LIMITER.limit({ key: clientKey }),
    env.SUSTAINED_RATE_LIMITER.limit({ key: clientKey }),
  ]);
  return burst.success && sustained.success;
}

const worker = {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    const origin = allowedCorsOrigin(request, env);
    if (origin === false) return jsonError('This browser origin is not allowed.', 403, null);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return jsonError('Method not allowed.', 405, origin, { Allow: 'GET, OPTIONS' });
    }
    if (requestUrl.pathname === '/health') {
      return Response.json({ ok: true, service: 'luffytv-stream-proxy' }, { headers: corsHeaders(origin) });
    }
    if (!await enforceRateLimits(request, env)) {
      return jsonError('Request rate limit exceeded.', 429, origin, { 'Retry-After': '60' });
    }
    if (!env.PROXY_SIGNING_SECRET || env.PROXY_SIGNING_SECRET.length < 32) {
      return jsonError('The proxy is not configured.', 503, origin);
    }
    if (!await verifySignature(requestUrl.searchParams, env)) {
      return jsonError('The proxy URL is invalid or has expired.', 401, origin);
    }

    const target = approvedTarget(requestUrl.searchParams.get('url') || '', env);
    if (!target) return jsonError('The streaming destination is not approved.', 403, origin);

    const referer = requestUrl.searchParams.get('referer') || '';
    const expiresAt = Number(requestUrl.searchParams.get('exp'));
    const upstreamHeaders = new Headers({
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'User-Agent': USER_AGENT,
    });
    if (referer) {
      try {
        const refererUrl = new URL(referer);
        if (refererUrl.protocol !== 'https:') return jsonError('The signed referer is malformed.', 400, origin);
        upstreamHeaders.set('Referer', refererUrl.toString());
        upstreamHeaders.set('Origin', refererUrl.origin);
      } catch {
        return jsonError('The signed referer is malformed.', 400, origin);
      }
    }
    const range = request.headers.get('Range');
    if (range) upstreamHeaders.set('Range', range);

    try {
      const { response: upstream, finalUrl } = await fetchApprovedTarget(target, upstreamHeaders, env);
      if (!upstream.ok) return jsonError(`The upstream returned HTTP ${upstream.status}.`, upstream.status, origin);

      const contentType = upstream.headers.get('content-type') || '';
      const lowerContentType = contentType.toLowerCase();
      const isManifest = /\.m3u8(?:$|[?#])/i.test(finalUrl.toString()) || lowerContentType.includes('mpegurl');
      const isSubtitle = /\.(?:vtt|srt|ass)(?:$|[?#])/i.test(finalUrl.toString()) || lowerContentType.includes('vtt');

      if (isManifest) {
        const manifest = await readTextWithLimit(upstream, MAX_MANIFEST_BYTES);
        const workerBase = requestUrl.origin;
        const proxyChild = (value) => signedProxyUrl(
          workerBase,
          normalizeManifestUrl(value, finalUrl),
          referer,
          expiresAt,
          env,
        );
        const lines = await Promise.all(manifest.split(/\r?\n/).map(async (line) => {
          let result = line;
          const matches = [...result.matchAll(/URI=["']([^"']+)["']/g)];
          for (const match of matches) {
            result = result.replace(match[0], `URI="${await proxyChild(match[1])}"`);
          }
          const trimmed = result.trim();
          return trimmed && !trimmed.startsWith('#') ? proxyChild(trimmed) : result;
        }));
        return new Response(lines.join('\n'), {
          status: upstream.status,
          headers: proxiedHeaders(origin, 'application/vnd.apple.mpegurl', 'private, no-store'),
        });
      }

      const isMedia = lowerContentType.includes('video') || lowerContentType.includes('audio') ||
        lowerContentType.includes('octet-stream') || lowerContentType.includes('mp4') ||
        lowerContentType.includes('mpeg');
      const headers = proxiedHeaders(
        origin,
        isSubtitle ? 'text/vtt; charset=utf-8' : isMedia ? contentType : 'application/octet-stream',
        isSubtitle ? 'public, max-age=3600' : 'public, max-age=3600, immutable',
      );
      for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (error) {
      console.log(JSON.stringify({ event: 'proxy_upstream_error', message: String(error) }));
      return jsonError('The streaming source could not be reached.', 502, origin);
    }
  },
};

export default worker;

export const testHelpers = {
  approvedTarget,
  isPrivateOrLocalHostname,
  signTarget,
};
