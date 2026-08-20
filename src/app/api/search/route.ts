import { NextResponse } from 'next/server';
import { waterfallSearch } from '@/lib/providers/catalog-waterfall';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { cacheHeaders, canBypassCache, noStoreHeaders } from '@/lib/api-cache';

export const dynamic = 'force-dynamic';

/**
 * GET /api/search?keyword=<query>
 *
 * Search anime by keyword.
 *
 * Query parameters:
 *   keyword  (required) – search term
 *   refresh=1           – bypass cache
 *
 * Example:
 *   /api/search?keyword=one+piece
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const keyword = searchParams.get('keyword')?.trim();
    const refreshRequested = searchParams.get('refresh') === '1';
    const page = parseInt(searchParams.get('page') || '1', 10);

    if (!keyword) {
      return NextResponse.json(
        { ok: false, message: 'keyword query parameter is required' },
        { status: 400, headers: noStoreHeaders }
      );
    }
    if (keyword.length > 80 || !Number.isInteger(page) || page < 1 || page > 100) {
      return NextResponse.json(
        { ok: false, message: 'keyword is limited to 80 characters and page to 1-100.' },
        { status: 400, headers: noStoreHeaders }
      );
    }
    if (refreshRequested && !canBypassCache(req)) {
      return NextResponse.json({ ok: false, message: 'Cache refresh is not authorized.' }, { status: 403, headers: noStoreHeaders });
    }
    const refresh = refreshRequested;

    const key = `search:${keyword.toLowerCase()}:page:${page}`;
    const data = await getOrSet(
      key,
      () => waterfallSearch(keyword, page, refresh),
      CACHE_TTL.SEARCH,
      refresh
    );

    return NextResponse.json({ ok: true, data }, { headers: cacheHeaders(CACHE_TTL.SEARCH) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/search]', message);
    return NextResponse.json({ ok: false, message }, { status: 500, headers: noStoreHeaders });
  }
}
