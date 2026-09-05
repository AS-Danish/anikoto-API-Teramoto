import { scrapeWatchStream, WatchData } from '@/lib/scrapers/watch.scraper';
import { hasPlayableWatchData, waterfallWatch } from '@/lib/providers/waterfall';
import { cacheGet, cacheSet, getOrSet } from '@/lib/cache';
import { canBypassCache, noStoreHeaders, validSlug } from '@/lib/api-cache';
import { recoverWatch, WATCH_TTL, watchCacheKey } from '@/lib/watch-recovery';
import { createSourceProbe } from '@/lib/media-health';
import { withFreshProxyUrls } from '@/lib/proxy-security';
import {
  playbackLog,
  playbackRequestId,
  safePlaybackError,
} from '@/lib/playback-diagnostics';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

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
  const requestId = playbackRequestId(req.headers.get('x-playback-request-id'));
  const startedAt = Date.now();
  try {
    const { searchParams } = new URL(req.url);
    const resolvedParams = await params;
    const slug = resolvedParams.slug;
    let epNum = searchParams.get('ep') || '1';
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
    epNum = String(parsedEpisode);

    if (searchParams.get('recover') === '1') {
      const recovered = await recoverWatch(slug, epNum, requestId);
      return Response.json(recovered.ok
        ? { ok: true, data: withFreshProxyUrls(recovered.data), streaming: false }
        : { ok: false, message: recovered.message, requestId }, {
        status: recovered.ok ? 200 : recovered.status,
        headers: { ...noStoreHeaders, 'X-Playback-Request-Id': requestId, ...(!recovered.ok ? { 'Retry-After': '30' } : {}) },
      });
    }

    const cacheKey = watchCacheKey(slug, epNum);
    playbackLog(requestId, 'api.watch.request', {
      slug,
      episode: epNum,
      stream: isStream,
      refresh,
      userAgent: (req.headers.get('user-agent') || '').slice(0, 120),
    });

    // ── Cache hit: respond instantly with plain JSON ──────────────────────────
    if (!refresh && isStream) {
      const cached = await cacheGet<WatchData>(cacheKey);
      if (cached !== undefined && hasPlayableWatchData(cached)) {
        playbackLog(requestId, 'api.watch.cache_hit', {
          sourceCount: cached.sources.length,
          elapsedMs: Date.now() - startedAt,
        });
        return Response.json(
          { ok: true, data: withFreshProxyUrls(cached), streaming: false },
          { headers: { ...noStoreHeaders, 'X-Playback-Request-Id': requestId } },
        );
      }
      if (cached !== undefined) {
        playbackLog(requestId, 'api.watch.poisoned_cache_ignored', {}, 'warn');
      }
    }

    // ── Non-streaming response: wait for all chunks and return JSON ──────────
    if (!isStream) {
      let data = await getOrSet(
        cacheKey,
        () => waterfallWatch(slug, epNum, requestId),
        WATCH_TTL,
        refresh,
        false,
      );
      // Older deployments could cache an empty source list as a successful
      // response. Bypass that poisoned value once and replace it with a valid
      // provider result.
      if (!hasPlayableWatchData(data)) {
        data = await getOrSet(
          cacheKey,
          () => waterfallWatch(slug, epNum, requestId),
          WATCH_TTL,
          true,
          false,
        );
      }
      if (!hasPlayableWatchData(data)) {
        throw new Error('No provider returned a playable video source.');
      }
      playbackLog(requestId, 'api.watch.resolved', {
        sourceCount: data.sources.length,
        serverCount: data.servers.length,
        provider: (data as WatchData & { source?: string }).source || 'unknown',
        mediaHosts: [...new Set(data.sources.map((source) => {
          try {
            return new URL(source.m3u8 || source.url).hostname;
          } catch {
            return '';
          }
        }).filter(Boolean))],
        elapsedMs: Date.now() - startedAt,
      });
      return Response.json(
        { ok: true, data: withFreshProxyUrls(data), streaming: false },
        { headers: { ...noStoreHeaders, 'X-Playback-Request-Id': requestId } },
      );
    }

    // ── Cache miss (or forced refresh): stream the response as SSE ────────────
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const probe = createSourceProbe(requestId);
        const collectedSources: WatchData['sources'] = [];
        let episode: WatchData['episode'] | undefined;
        let servers: WatchData['servers'] = [];
        let skip_data: WatchData['skip_data'] = null;

        try {
          for await (const chunk of scrapeWatchStream(slug, epNum, requestId)) {
            // Accumulate data to cache when complete
            if (chunk.type === 'episode') {
              episode = chunk.episode;
            } else if (chunk.type === 'servers') {
              servers = chunk.servers;
            } else if (chunk.type === 'skip_data') {
              skip_data = chunk.skip_data;
            } else if (chunk.type === 'source') {
              if (!await probe(chunk.source)) continue;
              collectedSources.push(chunk.source);
            } else if (chunk.type === 'done') {
              if (collectedSources.length === 0) {
                const fallback = await waterfallWatch(slug, epNum, requestId, 1, Math.max(1, 110_000 - (Date.now() - startedAt)));
                episode = fallback.episode;
                servers = fallback.servers;
                skip_data = fallback.skip_data;
                for (const source of fallback.sources) {
                  collectedSources.push(source);
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'source', source })}\n\n`));
                }
              }
              // Persist completed result so the next request is an instant cache hit
              if (episode) {
                const fullData: WatchData = { episode, skip_data, servers, sources: collectedSources };
                if (hasPlayableWatchData(fullData)) {
                  await cacheSet(cacheKey, fullData, WATCH_TTL);
                } else {
                  // Emit the failure before the terminal event. Clients are
                  // allowed to stop consuming as soon as they receive `done`.
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({
                      type: 'error',
                      ok: false,
                      message: 'No provider returned a playable video source.',
                    })}\n\n`),
                  );
                }
              }
            }

            // Forward the terminal `done` only after any final error event.
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
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
        'X-Playback-Request-Id': requestId,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[GET /api/watch]`, message);
    playbackLog(requestId, 'api.watch.failed', {
      error: safePlaybackError(err),
      elapsedMs: Date.now() - startedAt,
    }, 'error');
    return Response.json(
      { ok: false, message, requestId },
      { status: 500, headers: { ...noStoreHeaders, 'X-Playback-Request-Id': requestId } },
    );
  }
}
