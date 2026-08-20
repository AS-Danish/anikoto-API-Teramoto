import { NextResponse } from 'next/server';
import { scrapeRecommendations } from '@/lib/scrapers/anime.scraper';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { cacheHeaders, canBypassCache, noStoreHeaders, validSlug } from '@/lib/api-cache';

export const dynamic = 'force-dynamic';

/**
 * GET /api/anime/[slug]/recommendations
 *
 * Returns list of recommended anime cards for a given anime slug.
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

    const cacheKey = `anime:recommendations:api:${slug}`;

    const data = await getOrSet(
      cacheKey,
      () => scrapeRecommendations(slug, refresh),
      CACHE_TTL.ANIME,
      refresh
    );

    return NextResponse.json({ ok: true, data }, { headers: cacheHeaders(CACHE_TTL.ANIME) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/anime/[slug]/recommendations]', message);
    return NextResponse.json({ ok: false, message }, { status: 500, headers: noStoreHeaders });
  }
}
