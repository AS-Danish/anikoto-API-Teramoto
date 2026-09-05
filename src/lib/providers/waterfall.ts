import { scrapeAnimeDetail, scrapeAnimeEpisodes, scrapeRelatedAnime } from '../scrapers/anime.scraper';
import { scrapeWatch, WatchData } from '../scrapers/watch.scraper';
import { getConsumetAnime, getConsumetWatch } from './consumet.provider';
import { getShineiiAnime, getShineiiWatch } from './shineii.provider';
import { getAnilistAnime, getAnilistWatch } from './anilist.provider';
import { playbackLog, safePlaybackError } from '../playback-diagnostics';
import { hasMediaSource } from '../playable-source';
import { createSourceProbe } from '../media-health';
import { withDeadline } from '../deadline';

export function hasPlayableWatchData(data: unknown): data is WatchData {
  if (!data || typeof data !== 'object') return false;
  const sources = (data as { sources?: unknown }).sources;
  return Array.isArray(sources) && sources.some(hasMediaSource);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeWatchData(provider: string, slug: string, epNum: string, value: unknown): WatchData | null {
  if (hasPlayableWatchData(value)) return value;

  const raw = record(value);
  const stream = record(raw.stream);
  const rawSources = Array.isArray(stream.sources) ? stream.sources : [];
  if (!rawSources.length) return null;
  const rawTracks = Array.isArray(stream.subtitles) ? stream.subtitles : [];
  const sources = rawSources.flatMap((item, index) => {
    const source = record(item);
    const url = text(source.url) || text(source.file);
    const proxyUrl = text(source.proxyUrl);
    if (!url && !proxyUrl) return [];
    return [{
      server: text(source.server) || `${provider} ${index + 1}`,
      type: text(source.type) || 'sub',
      url,
      m3u8: text(source.m3u8) || (/\.m3u8(?:$|[?#])/i.test(url) ? url : null),
      referer: text(source.referer) || undefined,
      proxyUrl: proxyUrl || null,
      tracks: rawTracks.flatMap((item) => {
        const track = record(item);
        const file = text(track.file) || text(track.url);
        if (!file) return [];
        return [{
          file,
          label: text(track.label) || 'Subtitles',
          kind: text(track.kind) || 'captions',
          default: track.default === true,
          proxyUrl: text(track.proxyUrl) || undefined,
        }];
      }),
    }];
  });
  const episode = record(raw.episode);
  const servers = Array.isArray(raw.servers) ? raw.servers.flatMap((item, index) => {
    const server = record(item);
    const id = text(server.id) || text(server.linkId);
    if (!id) return [];
    return [{
      id,
      name: text(server.name) || `${provider} ${index + 1}`,
      type: text(server.type) || 'sub',
      svId: text(server.svId) || undefined,
    }];
  }) : [];
  return {
    episode: {
      number: text(episode.number) || epNum,
      title: text(episode.title) || `Episode ${epNum}`,
      href: text(episode.href) || `/watch/${slug}/ep-${epNum}`,
      id: text(episode.id) || undefined,
    },
    servers,
    sources,
    skip_data: null,
  };
}

function requirePlayableWatchData(
  provider: string,
  slug: string,
  epNum: string,
  data: unknown,
): WatchData {
  const normalized = normalizeWatchData(provider, slug, epNum, data);
  if (!normalized || !hasPlayableWatchData(normalized)) {
    throw new Error(`${provider} returned no playable sources`);
  }
  return normalized;
}

export async function waterfallAnimeDetail(slug: string, startEpisode?: number, endEpisode?: number, refresh?: boolean) {
  console.log(`\n[Waterfall] 🌊 Starting Detail Waterfall for: ${slug}`);
  
  // 1. Primary: Anikoto (Local Scraper)
  try {
    console.log(`[Waterfall] 1. Attempting Primary Anikoto Scraper...`);
    const [episodes, detail, seasons] = await Promise.all([
      scrapeAnimeEpisodes(slug, startEpisode, endEpisode, refresh),
      scrapeAnimeDetail(slug, refresh),
      scrapeRelatedAnime(slug, refresh),
    ]);
    console.log(`[Waterfall] ✅ Anikoto succeeded!`);
    return { ...detail, episodes, seasons, source: 'anikoto' };
  } catch (error) {
    const errObj = error as Error;
    console.error(`[Waterfall] ❌ Primary Anikoto failed: ${errObj.message || 'Unknown error'}`);
  }

  // 2. Fallback 1: Consumet
  try {
    console.log(`[Waterfall] 2. Attempting Consumet...`);
    const data = await getConsumetAnime(slug);
    if (data) {
        console.log(`[Waterfall] ✅ Consumet succeeded!`);
        return { ...data, source: 'consumet' };
    }
  } catch (error) {
    const errObj = error as Error;
    console.error(`[Waterfall] ❌ Consumet failed: ${errObj.message || 'Unknown error'}`);
  }

  // 3. Fallback 2: Shineii86 Deployment
  try {
    console.log(`[Waterfall] 3. Attempting Shineii...`);
    const data = await getShineiiAnime(slug);
    if (data) {
        console.log(`[Waterfall] ✅ Shineii succeeded!`);
        return { ...data, source: 'shineii' };
    }
  } catch (error) {
    const errObj = error as Error;
    console.error(`[Waterfall] ❌ Shineii failed: ${errObj.message || 'Unknown error'}`);
  }

  // 4. Fallback 3: Anilist (Metadata)
  try {
    console.log(`[Waterfall] 4. Attempting Anilist...`);
    const data = await getAnilistAnime(slug);
    if (data) {
        console.log(`[Waterfall] ✅ Anilist succeeded!`);
        return { ...data, source: 'anilist' };
    }
  } catch (error) {
    const errObj = error as Error;
    console.error(`[Waterfall] ❌ Anilist failed: ${errObj.message || 'Unknown error'}`);
  }

  console.error(`[Waterfall] 💥 FATAL: All providers failed for slug: ${slug}`);
  throw new Error('All waterfall providers failed to fetch anime details for slug: ' + slug);
}

export async function waterfallWatch(slug: string, epNum: string, requestId = 'untracked', startAt = 0, budgetMs = 80_000) {
  const probe = createSourceProbe(requestId);
  const deadline = Date.now() + budgetMs;
  const attempts: Array<{
    name: string;
    source: string;
    load: () => Promise<unknown>;
  }> = [
    {
      name: 'Anikoto',
      source: 'anikoto',
      load: () => scrapeWatch(slug, epNum, requestId),
    },
    {
      name: 'Consumet',
      source: 'consumet',
      load: () => getConsumetWatch(slug, epNum),
    },
    {
      name: 'Shineii',
      source: 'shineii',
      load: () => getShineiiWatch(slug, epNum, requestId),
    },
    {
      name: 'GogoAnime',
      source: 'gogoanime',
      load: () => getAnilistWatch(slug, epNum),
    },
  ];

  for (const [index, attempt] of attempts.entries()) {
    if (index < startAt) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const startedAt = Date.now();
    playbackLog(requestId, 'provider.attempt_started', {
      provider: attempt.name,
      order: index + 1,
    });
    try {
      const data = await withDeadline((async () => {
        const candidate = requirePlayableWatchData(
          attempt.name,
          slug,
          epNum,
          await attempt.load(),
        );
        const checks = await Promise.all(candidate.sources.map((source) => hasMediaSource(source) ? probe(source) : false));
        const sources = candidate.sources.filter((_, index) => checks[index]);
        if (!sources.length) throw new Error(`${attempt.name} returned no reachable media`);
        return { ...candidate, sources };
      })(), Math.min(index === 0 ? 40_000 : 25_000, remaining));
      playbackLog(requestId, 'provider.attempt_succeeded', {
        provider: attempt.name,
        sourceCount: data.sources.length,
        serverCount: data.servers.length,
        elapsedMs: Date.now() - startedAt,
      });
      return { ...data, source: attempt.source };
    } catch (error) {
      playbackLog(requestId, 'provider.attempt_failed', {
        provider: attempt.name,
        elapsedMs: Date.now() - startedAt,
        error: safePlaybackError(error),
      }, 'warn');
    }
  }

  playbackLog(requestId, 'provider.waterfall_exhausted', {
    slug,
    episode: epNum,
  }, 'error');
  throw new Error(`All waterfall providers failed for ${slug} episode ${epNum}`);
}
