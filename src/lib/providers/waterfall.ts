import { scrapeAnimeDetail, scrapeAnimeEpisodes, scrapeRelatedAnime } from '../scrapers/anime.scraper';
import { scrapeWatch, WatchData } from '../scrapers/watch.scraper';
import { getConsumetAnime, getConsumetWatch } from './consumet.provider';
import { getShineiiAnime, getShineiiWatch } from './shineii.provider';
import { getAnilistAnime, getAnilistWatch } from './anilist.provider';

export function hasPlayableWatchData(data: unknown): data is WatchData {
  if (!data || typeof data !== 'object') return false;
  const sources = (data as { sources?: unknown }).sources;
  return Array.isArray(sources) && sources.some((source) => {
    if (!source || typeof source !== 'object') return false;
    const candidate = source as { proxyUrl?: unknown; m3u8?: unknown; url?: unknown };
    return [candidate.proxyUrl, candidate.m3u8, candidate.url]
      .some((value) => typeof value === 'string' && value.trim().length > 0);
  });
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

export async function waterfallWatch(slug: string, epNum: string) {
  console.log(`\n[Waterfall] 🌊 Starting Watch Waterfall for: ${slug} | Ep: ${epNum}`);
  
  // 1. Primary: Anikoto (Local Scraper)
  try {
    console.log(`[Waterfall] 1. Attempting Primary Anikoto Scraper...`);
    const data = requirePlayableWatchData('Anikoto', slug, epNum, await scrapeWatch(slug, epNum));
    console.log(`[Waterfall] ✅ Anikoto succeeded!`);
    return { ...data, source: 'anikoto' };
  } catch (error) {
    const errObj = error as Error;
    console.error(`[Waterfall] ❌ Primary Anikoto failed: ${errObj.message || 'Unknown error'}`);
  }

  // 2. Fallback 1: Consumet
  try {
    console.log(`[Waterfall] 2. Attempting Consumet...`);
    const data = requirePlayableWatchData('Consumet', slug, epNum, await getConsumetWatch(slug, epNum));
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
    const data = requirePlayableWatchData('Shineii', slug, epNum, await getShineiiWatch(slug, epNum));
    if (data) {
        console.log(`[Waterfall] ✅ Shineii succeeded!`);
        return { ...data, source: 'shineii' };
    }
  } catch (error) {
    const errObj = error as Error;
    console.error(`[Waterfall] ❌ Shineii failed: ${errObj.message || 'Unknown error'}`);
  }

  // 4. Fallback 3: Anilist + GogoAnime
  try {
    console.log(`[Waterfall] 4. Attempting GogoAnime Fallback...`);
    const data = requirePlayableWatchData('GogoAnime', slug, epNum, await getAnilistWatch(slug, epNum));
    if (data) {
        console.log(`[Waterfall] ✅ GogoAnime succeeded!`);
        return { ...data, source: 'gogoanime' };
    }
  } catch (error) {
    const errObj = error as Error;
    console.error(`[Waterfall] ❌ GogoAnime failed: ${errObj.message || 'Unknown error'}`);
  }

  console.error(`[Waterfall] 💥 FATAL: All providers failed for watch: ${slug} (Ep: ${epNum})`);
  throw new Error('All waterfall providers failed to fetch watch data for slug: ' + slug + ' ep: ' + epNum);
}
