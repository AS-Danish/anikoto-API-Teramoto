export function cacheHeaders(ttl: number, staleWhileRevalidate = Math.max(ttl * 6, 300)) {
  const value = `public, max-age=30, s-maxage=${ttl}, stale-while-revalidate=${staleWhileRevalidate}, stale-if-error=86400`;
  return {
    'Cache-Control': value,
    'CDN-Cache-Control': value,
    'Vercel-CDN-Cache-Control': value,
  };
}

export const noStoreHeaders = {
  'Cache-Control': 'private, no-store',
};

export function canBypassCache(request: Request) {
  const secret = process.env.CACHE_REFRESH_SECRET;
  const supplied = request.headers.get('x-cache-refresh-token');
  return Boolean(secret && supplied && supplied === secret);
}

export function validSlug(value: string) {
  return /^[a-z0-9][a-z0-9-]{0,199}$/i.test(value);
}
