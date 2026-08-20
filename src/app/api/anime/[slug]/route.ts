import { NextResponse } from 'next/server';
import { waterfallAnimeDetail } from '@/lib/providers/waterfall';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { cacheHeaders, canBypassCache, noStoreHeaders, validSlug } from '@/lib/api-cache';

export const dynamic = 'force-dynamic';

/**
 * GET /api/anime/[slug]
 *
 * Returns detail info for an anime: title, synopsis, genres, studios,
 * MAL score, episode count, status, etc.
 *
 * Supports optional episode range filter (same as /episodes endpoint):
 *   ?start=1&end=12
 *
 * Examples:
 *   /api/anime/haibara-s-teenage-new-game-8axzw
 *   /api/anime/one-piece-odmau
 *   /api/anime/one-piece-odmau?start=1&end=50
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

    // Handle optional episode range parameters
    const start = searchParams.get('start');
    const end = searchParams.get('end');

    let startEpisode: number | undefined;
    let endEpisode: number | undefined;

    if (start || end) {
      if (!start || !end) {
        return NextResponse.json(
          { ok: false, message: 'Both start and end are required when filtering by episode range.' },
          { status: 400, headers: noStoreHeaders }
        );
      }
      const s = parseInt(start, 10);
      const e = parseInt(end, 10);
      if (isNaN(s) || isNaN(e) || s <= 0 || e <= 0 || s > e) {
        return NextResponse.json(
          { ok: false, message: 'Invalid episode range. start and end must be positive integers with start <= end.' },
          { status: 400, headers: noStoreHeaders }
        );
      }
      startEpisode = s;
      endEpisode = e;
    }

    const rangeSuffix = startEpisode !== undefined ? `:ep${startEpisode}-${endEpisode}` : '';
    const key = `anime:${slug}${rangeSuffix}`;

    const data = await getOrSet(
      key,
      () => waterfallAnimeDetail(slug, startEpisode, endEpisode, refresh),
      CACHE_TTL.ANIME,
      refresh
    );

    return NextResponse.json({ ok: true, data }, { headers: cacheHeaders(CACHE_TTL.ANIME) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/anime/[slug]]', message);
    return NextResponse.json({ ok: false, message }, { status: 500, headers: noStoreHeaders });
  }
}


