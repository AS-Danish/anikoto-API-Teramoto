import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_VERSION = '1';
const DEFAULT_PROXY_TTL_SECONDS = 2 * 60 * 60;
const MAX_PROXY_TTL_SECONDS = 6 * 60 * 60;
const CLOCK_SKEW_SECONDS = 30;

export const DEFAULT_APPROVED_STREAM_HOSTS = [
  'cdn.watching.onl',
  '*.watching.onl',
  's1.akirax.buzz',
  '*.akirax.buzz',
  '*.mewstream.buzz',
  '*.zaplume.buzz',
  '*.megaplay.buzz',
  '*.megacloud.tv',
  '*.gogocdn.net',
  '*.gogoplay4.com',
  '*.vidstreaming.io',
  '*.vidcloud9.com',
  '*.embtaku.pro',
].join(',');

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function proxyTtlSeconds() {
  return Math.min(
    MAX_PROXY_TTL_SECONDS,
    Math.max(300, positiveInteger(process.env.PROXY_URL_TTL_SECONDS, DEFAULT_PROXY_TTL_SECONDS)),
  );
}

function signingSecret() {
  const secret = process.env.PROXY_SIGNING_SECRET ||
    (process.env.NODE_ENV !== 'production' ? process.env.CACHE_REFRESH_SECRET : undefined);
  if (!secret || secret.length < 32) {
    throw new Error('PROXY_SIGNING_SECRET must contain at least 32 characters.');
  }
  return secret;
}

function signaturePayload(targetUrl: string, referer: string, expiresAt: number) {
  return `${SIGNATURE_VERSION}\n${expiresAt}\n${targetUrl}\n${referer}`;
}

function signatureFor(secret: string, targetUrl: string, referer: string, expiresAt: number) {
  return createHmac('sha256', secret)
    .update(signaturePayload(targetUrl, referer, expiresAt), 'utf8')
    .digest('hex');
}

function safeEqualHex(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function buildSignedProxyUrl(
  proxyBase: string,
  targetUrl: string,
  referer = '',
  expiresAt = Math.floor(Date.now() / 1_000) + proxyTtlSeconds(),
) {
  const normalizedBase = proxyBase.trim();
  if (!normalizedBase) throw new Error('A proxy base URL is required.');
  if (!parseApprovedProxyTarget(targetUrl)) {
    throw new Error('Refusing to sign an unapproved streaming destination.');
  }
  const params = new URLSearchParams({
    url: targetUrl,
    exp: String(expiresAt),
    v: SIGNATURE_VERSION,
    sig: signatureFor(signingSecret(), targetUrl, referer, expiresAt),
  });
  if (referer) params.set('referer', referer);
  return `${normalizedBase}${normalizedBase.includes('?') ? '&' : '?'}${params.toString()}`;
}

export function makeSignedProxyUrlBuilder() {
  const rawBaseUrl = process.env.CF_WORKER_URL || '/api/proxy';
  const proxyBase = rawBaseUrl.trim() && !rawBaseUrl.startsWith('http') && !rawBaseUrl.startsWith('/')
    ? `https://${rawBaseUrl.trim()}`
    : rawBaseUrl.trim();
  return (targetUrl: string, referer?: string) => buildSignedProxyUrl(proxyBase, targetUrl, referer);
}

export function verifyProxySignature(searchParams: URLSearchParams) {
  const targetUrl = searchParams.get('url') || '';
  const referer = searchParams.get('referer') || '';
  const signature = searchParams.get('sig') || '';
  const version = searchParams.get('v') || '';
  const expiresAt = Number(searchParams.get('exp'));
  const now = Math.floor(Date.now() / 1_000);

  if (!targetUrl || version !== SIGNATURE_VERSION || !Number.isInteger(expiresAt)) return false;
  if (expiresAt < now - CLOCK_SKEW_SECONDS || expiresAt > now + MAX_PROXY_TTL_SECONDS + CLOCK_SKEW_SECONDS) {
    return false;
  }

  const secrets = [process.env.PROXY_SIGNING_SECRET, process.env.PROXY_SIGNING_SECRET_PREVIOUS]
    .filter((value): value is string => Boolean(value && value.length >= 32));
  if (process.env.NODE_ENV !== 'production' && process.env.CACHE_REFRESH_SECRET) {
    secrets.push(process.env.CACHE_REFRESH_SECRET);
  }
  return secrets.some((secret) => safeEqualHex(
    signature,
    signatureFor(secret, targetUrl, referer, expiresAt),
  ));
}

function ipv4Parts(hostname: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
  const parts = hostname.split('.').map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

function isBlockedIpv4(hostname: string) {
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

function isBlockedIpv6(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes(':')) return false;
  if (host === '::' || host === '::1') return true;
  if (/^(?:fc|fd)/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host) || /^2001:db8/.test(host)) {
    return true;
  }
  const mapped = host.match(/(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mapped ? isBlockedIpv4(mapped[1]) : false;
}

export function isPrivateOrLocalHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || host.endsWith('.home.arpa') ||
    isBlockedIpv4(host) || isBlockedIpv6(host);
}

function approvedHostPatterns() {
  return (process.env.APPROVED_STREAM_HOSTS || DEFAULT_APPROVED_STREAM_HOSTS)
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
}

function hostMatches(hostname: string, pattern: string) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === pattern;
}

export function parseApprovedProxyTarget(value: string) {
  if (!value || value.length > 8_192) return null;
  try {
    const target = new URL(value);
    const hostname = target.hostname.toLowerCase().replace(/\.$/, '');
    if (target.protocol !== 'https:' || target.username || target.password || isPrivateOrLocalHostname(hostname)) {
      return null;
    }
    if (!approvedHostPatterns().some((pattern) => hostMatches(hostname, pattern))) return null;
    return target;
  } catch {
    return null;
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resignSource(source: unknown, getProxyUrl: (url: string, referer?: string) => string) {
  if (!isObject(source)) return;
  const referer = typeof source.referer === 'string' ? source.referer : undefined;
  const mediaUrl = typeof source.m3u8 === 'string' && source.m3u8
    ? source.m3u8
    : typeof source.proxyUrl === 'string' && source.proxyUrl && typeof source.url === 'string' && source.url
      ? source.url
      : '';
  if (mediaUrl) {
    try {
      source.proxyUrl = getProxyUrl(mediaUrl, referer);
    } catch {
      source.proxyUrl = null;
    }
  }
  if (Array.isArray(source.tracks)) {
    for (const track of source.tracks) {
      if (isObject(track) && typeof track.file === 'string' && track.file) {
        try {
          track.proxyUrl = getProxyUrl(track.file, referer);
        } catch {
          delete track.proxyUrl;
        }
      }
    }
  }
}

/** Refreshes signatures without mutating the shared cached watch object. */
export function withFreshProxyUrls<T>(data: T): T {
  const clone = structuredClone(data);
  if (!isObject(clone)) return clone;
  const getProxyUrl = makeSignedProxyUrlBuilder();
  if (Array.isArray(clone.sources)) clone.sources.forEach((source) => resignSource(source, getProxyUrl));
  if (isObject(clone.stream)) {
    if (Array.isArray(clone.stream.sources)) {
      clone.stream.sources.forEach((source) => resignSource(source, getProxyUrl));
    }
    if (Array.isArray(clone.stream.subtitles)) {
      for (const track of clone.stream.subtitles) {
        if (!isObject(track)) continue;
        const file = typeof track.file === 'string' ? track.file : typeof track.url === 'string' ? track.url : '';
        if (file) {
          try {
            track.proxyUrl = getProxyUrl(file);
          } catch {
            delete track.proxyUrl;
          }
        }
      }
    }
  }
  return clone;
}
