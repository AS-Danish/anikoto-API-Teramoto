import { NextResponse } from 'next/server';
import { waterfallHome } from '@/lib/providers/catalog-waterfall';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { cacheHeaders, canBypassCache, noStoreHeaders } from '@/lib/api-cache';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/home
 *
 * Returns the full home page data including:
 *  - spotlight (featured anime carousel)
 *  - latestEpisodes
 *  - newRelease, newAdded, justCompleted
 *  - topDay, topWeek, topMonth
 *
 * @query refresh=1  Bypass cache and force re-scrape
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const refreshRequested = searchParams.get('refresh') === '1';
    if (refreshRequested && !canBypassCache(req)) {
      return NextResponse.json({ ok: false, message: 'Cache refresh is not authorized.' }, { status: 403, headers: noStoreHeaders });
    }
    const refresh = refreshRequested;
    const widget = searchParams.get('widget');
    const page = parseInt(searchParams.get('page') ?? '1', 10);
    if (!Number.isInteger(page) || page < 1 || page > 100) {
      return NextResponse.json({ ok: false, message: 'page must be between 1 and 100.' }, { status: 400, headers: noStoreHeaders });
    }
    if (widget && !/^[a-z0-9-]{1,40}$/i.test(widget)) {
      return NextResponse.json({ ok: false, message: 'Invalid widget name.' }, { status: 400, headers: noStoreHeaders });
    }

    if (widget) {
      const key = `home:widget:${widget}:${page}`;
      const data = await getOrSet(
        key,
        () => waterfallHome(refresh, widget, page),
        CACHE_TTL.HOME,
        refresh
      );
      return NextResponse.json({ ok: true, data }, { headers: cacheHeaders(CACHE_TTL.HOME) });
    }

    const key = 'home';
    const data = await getOrSet(
      key,
      () => waterfallHome(refresh),
      CACHE_TTL.HOME,
      refresh
    );

    return NextResponse.json({ ok: true, data }, { headers: cacheHeaders(CACHE_TTL.HOME) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/home]', message);
    return NextResponse.json({ ok: false, message }, { status: 500, headers: noStoreHeaders });
  }
}
