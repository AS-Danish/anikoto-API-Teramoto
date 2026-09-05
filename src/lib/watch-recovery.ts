import { cacheSet, consumeRateLimit, getOrSet } from './cache';
import { waterfallWatch } from './providers/waterfall';
import { playbackLog, safePlaybackError } from './playback-diagnostics';
import type { WatchData } from './scrapers/watch.scraper';

export const WATCH_TTL = 60;
export const watchCacheKey = (slug: string, episode: string) => `watch:v2:${slug.toLowerCase()}:${Number(episode)}`;

type RecoveryResult = { ok: true; data: WatchData } | { ok: false; status: number; message: string };

/** Public recovery is bounded and never exposes the administrative refresh secret.
 * Cache failures as well as successes so an outage cannot cause a retry storm.
 */
export async function recoverWatch(slug: string, episode: string, requestId: string): Promise<RecoveryResult> {
  const key = watchCacheKey(slug, episode);
  return getOrSet<RecoveryResult>(`recovery:${key}`, async () => {
    if (!await consumeRateLimit('watch-recovery', 60, 60)) {
      return { ok: false, status: 429, message: 'Video recovery is busy. Retry in 30 seconds.' };
    }
    try {
      // This deliberately bypasses the normal watch result, but shares the
      // catalog cache and the existing upstream concurrency controls.
      const data = await waterfallWatch(slug, String(Number(episode)), requestId);
      await cacheSet(key, data, WATCH_TTL);
      playbackLog(requestId, 'api.watch.recovered', { slug, episode, sourceCount: data.sources.length });
      return { ok: true, data };
    } catch (error) {
      playbackLog(requestId, 'api.watch.recovery_failed', { slug, episode, error: safePlaybackError(error) }, 'warn');
      return { ok: false, status: 503, message: 'No working video source is available. Retry in 30 seconds.' };
    }
  }, 30, false, false);
}
