import { NextResponse } from 'next/server';
import { waterfallEpisodes } from '@/lib/providers/catalog-waterfall';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { cacheHeaders, canBypassCache, noStoreHeaders, validSlug } from '@/lib/api-cache';

export const dynamic = 'force-dynamic';

/**
 * GET /api/anime/[slug]/episodes
 *
 * Returns the full episode list for an anime, optionally filtered by episode range.
 *
 * Example:
 *   /api/anime/haibara-s-teenage-new-game-8axzw/episodes
 *   /api/anime/haibara-s-teenage-new-game-8axzw/episodes?start=5&end=10
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    if (!validSlug(slug)) {
      return NextResponse.json({ ok: false, message: 'A valid slug is required' }, { status: 400, headers: noStoreHeaders });
    }

    const { searchParams } = new URL(req.url);
    const refreshRequested = searchParams.get('refresh') === '1';
    if (refreshRequested && !canBypassCache(req)) {
      return NextResponse.json({ ok: false, message: 'Cache refresh is not authorized.' }, { status: 403, headers: noStoreHeaders });
    }
    const refresh = refreshRequested;

    // Handle episode range parameters
    const start = searchParams.get('start');
    const end = searchParams.get('end');
    
    let startEpisode: number | undefined = undefined;
    let endEpisode: number | undefined = undefined;
    let cacheKey = `anime:episodes:${slug}`;

    if (start && end) {
      const s = parseInt(start, 10);
      const e = parseInt(end, 10);
      if (!isNaN(s) && !isNaN(e) && s > 0 && e > 0 && s <= e) {
        startEpisode = s;
        endEpisode = e;
        cacheKey += `:${s}-${e}`;
      } else {
        return NextResponse.json({ ok: false, message: 'Invalid episode range. Start and End must be positive integers, and Start <= End.' }, { status: 400, headers: noStoreHeaders });
      }
    }

    const data = await getOrSet(
      cacheKey,
      () => waterfallEpisodes(slug, startEpisode, endEpisode, refresh),
      CACHE_TTL.EPISODE,
      refresh
    );

    return NextResponse.json({ ok: true, data }, { headers: cacheHeaders(CACHE_TTL.EPISODE) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/anime/[slug]/episodes]', message);
    return NextResponse.json({ ok: false, message }, { status: 500, headers: noStoreHeaders });
  }
}
