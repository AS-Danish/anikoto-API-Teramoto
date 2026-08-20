import { scrapeWatchStream, WatchData } from '@/lib/scrapers/watch.scraper';
import { waterfallWatch } from '@/lib/providers/waterfall';
import { cacheGet, cacheSet, getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { cacheHeaders, canBypassCache, noStoreHeaders, validSlug } from '@/lib/api-cache';
import { withFreshProxyUrls } from '@/lib/proxy-security';

export const dynamic = 'force-dynamic';

/**
 * GET /api/watch/[slug]?ep=1
 *
 * Retrieves video servers and stream sources for a specific episode.
 *
 * Behaviour:
 * - Cache warm  → instant JSON response  { ok: true, data, streaming: false }
 * - Cache cold  → SSE streaming response (text/event-stream); chunks arrive progressively:
 *     1. data: { "type": "episode", "episode": {...} }          — after ~1 upstream RTT
 *     2. data: { "type": "servers", "servers": [...] }          — after ~2 upstream RTTs
 *     3. data: { "type": "source",  "source": {...} }  (×N)    — as each server resolves
 *     4. data: { "type": "done" }                               — stream closed; result cached
 *
 * Add ?refresh=1 to bypass cache and force a fresh stream.
 * Add ?stream=false to disable streaming and return full JSON response.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { searchParams } = new URL(req.url);
    const resolvedParams = await params;
    const slug = resolvedParams.slug;
    const epNum = searchParams.get('ep') || '1';
    const refreshRequested = searchParams.get('refresh') === '1';
    const isStream = searchParams.get('stream') !== 'false';

    const parsedEpisode = Number(epNum);
    if (!validSlug(slug) || !Number.isInteger(parsedEpisode) || parsedEpisode < 1 || parsedEpisode > 100_000) {
      return Response.json({ ok: false, message: 'Invalid slug or episode number.' }, { status: 400, headers: noStoreHeaders });
    }
    if (refreshRequested && !canBypassCache(req)) {
      return Response.json({ ok: false, message: 'Cache refresh is not authorized.' }, { status: 403, headers: noStoreHeaders });
    }
    const refresh = refreshRequested;

    const cacheKey = `watch:${slug}:${epNum}`;

    // ── Cache hit: respond instantly with plain JSON ──────────────────────────
    if (!refresh && isStream) {
      const cached = await cacheGet<WatchData>(cacheKey);
      if (cached !== undefined) {
        return Response.json(
          { ok: true, data: withFreshProxyUrls(cached), streaming: false },
          { headers: cacheHeaders(60, 120) },
        );
      }
    }

    // ── Non-streaming response: wait for all chunks and return JSON ──────────
    if (!isStream) {
      const data = await getOrSet(
        cacheKey,
        () => waterfallWatch(slug, epNum),
        CACHE_TTL.EPISODE,
        refresh,
      );
      return Response.json(
        { ok: true, data: withFreshProxyUrls(data), streaming: false },
        { headers: cacheHeaders(60, 120) },
      );
    }

    // ── Cache miss (or forced refresh): stream the response as SSE ────────────
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const collectedSources: WatchData['sources'] = [];
        let episode: WatchData['episode'] | undefined;
        let servers: WatchData['servers'] = [];
        let skip_data: WatchData['skip_data'] = null;

        try {
          for await (const chunk of scrapeWatchStream(slug, epNum)) {
            // Forward each chunk in SSE format
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

            // Accumulate data to cache when complete
            if (chunk.type === 'episode') {
              episode = chunk.episode;
            } else if (chunk.type === 'servers') {
              servers = chunk.servers;
            } else if (chunk.type === 'skip_data') {
              skip_data = chunk.skip_data;
            } else if (chunk.type === 'source') {
              collectedSources.push(chunk.source);
            } else if (chunk.type === 'done') {
              // Persist completed result so the next request is an instant cache hit
              if (episode) {
                const fullData: WatchData = { episode, skip_data, servers, sources: collectedSources };
                await cacheSet(cacheKey, fullData, CACHE_TTL.EPISODE);
              }
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[GET /api/watch stream]`, message);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'error', ok: false, message })}\n\n`)
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Transfer-Encoding': 'chunked',
        'X-Accel-Buffering': 'no', // Disable Nginx/proxy buffering
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[GET /api/watch]`, message);
    return Response.json({ ok: false, message }, { status: 500, headers: noStoreHeaders });
  }
}
