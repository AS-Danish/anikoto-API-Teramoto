import { NextResponse } from 'next/server';
import { waterfallSchedule } from '@/lib/providers/catalog-waterfall';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { cacheHeaders, canBypassCache, noStoreHeaders } from '@/lib/api-cache';

export const dynamic = 'force-dynamic';

/**
 * GET /api/schedule
 *
 * Returns the weekly anime airing schedule.
 *
 * Query parameters:
 *   refresh=1  – bypass cache
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const refreshRequested = searchParams.get('refresh') === '1';
    if (refreshRequested && !canBypassCache(req)) {
      return NextResponse.json({ ok: false, message: 'Cache refresh is not authorized.' }, { status: 403, headers: noStoreHeaders });
    }
    const refresh = refreshRequested;
    const tz = searchParams.has('tz') ? parseInt(searchParams.get('tz')!, 10) : 0;
    const images = searchParams.get('images') === 'true';
    if (!Number.isInteger(tz) || tz < -12 || tz > 14) {
      return NextResponse.json({ ok: false, message: 'tz must be between -12 and 14.' }, { status: 400, headers: noStoreHeaders });
    }

    const key = `schedule:tz${tz}:img:${images}`;
    const data = await getOrSet(
      key,
      () => waterfallSchedule(tz, images),
      CACHE_TTL.SCHEDULE,
      refresh,
    );

    return NextResponse.json({ ok: true, data }, { headers: cacheHeaders(CACHE_TTL.SCHEDULE) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/schedule]', message);
    return NextResponse.json({ ok: false, message }, { status: 500, headers: noStoreHeaders });
  }
}
