import { scrapeAnimeEpisodes } from '../scrapers/anime.scraper';
import { scrapeHome, scrapeHomeWidget } from '../scrapers/home.scraper';
import { scrapeSchedule } from '../scrapers/schedule.scraper';
import { scrapeSearch } from '../scrapers/search.scraper';
import { withUpstreamLimit } from '../cache';

type JsonRecord = Record<string, unknown>;

const shineiiBaseUrl = (process.env.SHINEII_URL || '').replace(/\/$/, '');

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requestShineii(path: string) {
  if (!shineiiBaseUrl) throw new Error('SHINEII_URL is not configured.');
  return withUpstreamLimit(async () => {
    const response = await fetch(`${shineiiBaseUrl}${path}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Shineii fallback failed (${response.status}).`);
    const payload = await response.json() as unknown;
    if (!isRecord(payload) || payload.success !== true) {
      throw new Error('Shineii fallback returned an invalid response.');
    }
    return payload.results;
  });
}

export async function waterfallHome(refresh = false, widget?: string | null, page = 1) {
  try {
    return widget ? await scrapeHomeWidget(widget, page) : await scrapeHome(refresh);
  } catch (primaryError) {
    if (widget) throw primaryError;
    return requestShineii('/api/');
  }
}

export async function waterfallSearch(keyword: string, page: number, refresh = false) {
  try {
    return await scrapeSearch(keyword, page, refresh);
  } catch {
    const fallback = await requestShineii(
      `/api/search?keyword=${encodeURIComponent(keyword)}&page=${page}`,
    );
    if (!isRecord(fallback)) return { results: [], keyword };
    const results = Array.isArray(fallback.data)
      ? fallback.data
      : Array.isArray(fallback.results)
        ? fallback.results
        : [];
    return { results, keyword, pagination: fallback.pagination };
  }
}

export async function waterfallEpisodes(
  slug: string,
  startEpisode?: number,
  endEpisode?: number,
  refresh = false,
) {
  try {
    return await scrapeAnimeEpisodes(slug, startEpisode, endEpisode, refresh);
  } catch {
    const fallback = await requestShineii(`/api/episodes/${encodeURIComponent(slug)}`);
    const record = isRecord(fallback) ? fallback : {};
    const rawEpisodes = Array.isArray(record.episodes)
      ? record.episodes
      : Array.isArray(fallback)
        ? fallback
        : [];
    const episodes = rawEpisodes
      .filter(isRecord)
      .map((episode) => {
        const rawNumber = episode.number ?? episode.episode_no;
        const number = String(rawNumber ?? '');
        return {
          number,
          title: typeof episode.title === 'string' ? episode.title : `Episode ${number}`,
          href: typeof episode.href === 'string' ? episode.href : `/watch/${slug}?ep=${number}`,
          id: typeof episode.id === 'string' ? episode.id : undefined,
          dataIds: typeof episode.server_ids === 'string' ? episode.server_ids : undefined,
          hasSub: episode.hasSub === true || episode.has_sub === true,
          hasDub: episode.hasDub === true || episode.has_dub === true,
        };
      })
      .filter((episode) => {
        const number = Number(episode.number);
        if (!Number.isFinite(number)) return false;
        if (startEpisode !== undefined && number < startEpisode) return false;
        if (endEpisode !== undefined && number > endEpisode) return false;
        return true;
      });
    return {
      animeId: String(record.animeId ?? record.id ?? slug),
      slug,
      episodes,
    };
  }
}

export async function waterfallSchedule(timezoneOffset: number, images: boolean) {
  try {
    return await scrapeSchedule(timezoneOffset, undefined, images);
  } catch {
    const today = new Date();
    const days: Array<{ day: string; animes: unknown[] }> = [];
    for (let index = 0; index < 7; index += 1) {
      const date = new Date(today);
      date.setUTCDate(today.getUTCDate() + index);
      const isoDate = date.toISOString().slice(0, 10);
      const fallback = await requestShineii(`/api/schedule?date=${isoDate}`);
      const animes = Array.isArray(fallback)
        ? fallback.filter(isRecord).map((anime) => ({
            ...anime,
            date: anime.date ?? anime.time ?? 'TBA',
            type: anime.type ?? (anime.episode_no ? `Episode ${anime.episode_no}` : 'New episode'),
          }))
        : [];
      days.push({
        day: date.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: '2-digit',
          timeZone: 'UTC',
        }),
        animes,
      });
    }
    return days;
  }
}
