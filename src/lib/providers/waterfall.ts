import { scrapeAnimeDetail, scrapeAnimeEpisodes, scrapeRelatedAnime } from '../scrapers/anime.scraper';
import { scrapeWatch } from '../scrapers/watch.scraper';
import { getConsumetAnime, getConsumetWatch } from './consumet.provider';
import { getShineiiAnime, getShineiiWatch } from './shineii.provider';
import { getAnilistAnime, getAnilistWatch } from './anilist.provider';

export async function waterfallAnimeDetail(slug: string, startEpisode?: number, endEpisode?: number, refresh?: boolean) {
  // 1. Primary: Anikoto (Local Scraper)
  try {
    const [episodes, detail, seasons] = await Promise.all([
      scrapeAnimeEpisodes(slug, startEpisode, endEpisode, refresh),
      scrapeAnimeDetail(slug, refresh),
      scrapeRelatedAnime(slug, refresh),
    ]);
    return { ...detail, episodes, seasons, source: 'anikoto' };
  } catch (error) {
    console.error('[Waterfall] Primary Anikoto scraper failed:', error);
  }

  // 2. Fallback 1: Consumet
  try {
    const data = await getConsumetAnime(slug);
    if (data) return { ...data, source: 'consumet' };
  } catch (error) {
    console.error('[Waterfall] Fallback 1 (Consumet) failed:', error);
  }

  // 3. Fallback 2: Shineii86 Deployment
  try {
    const data = await getShineiiAnime(slug);
    if (data) return { ...data, source: 'shineii' };
  } catch (error) {
    console.error('[Waterfall] Fallback 2 (Shineii) failed:', error);
  }

  // 4. Fallback 3: Anilist (Metadata)
  try {
    const data = await getAnilistAnime(slug);
    if (data) return { ...data, source: 'anilist' };
  } catch (error) {
    console.error('[Waterfall] Fallback 3 (Anilist) failed:', error);
  }

  throw new Error('All waterfall providers failed to fetch anime details for slug: ' + slug);
}

export async function waterfallWatch(slug: string, epNum: string) {
  // 1. Primary: Anikoto (Local Scraper)
  try {
    const data = await scrapeWatch(slug, epNum);
    return { ...data, source: 'anikoto' };
  } catch (error) {
    console.error('[Waterfall] Primary Anikoto watch failed:', error);
  }

  // 2. Fallback 1: Consumet
  try {
    const data = await getConsumetWatch(slug, epNum);
    if (data) return { ...data, source: 'consumet' };
  } catch (error) {
    console.error('[Waterfall] Fallback 1 (Consumet) watch failed:', error);
  }

  // 3. Fallback 2: Shineii86 Deployment
  try {
    const data = await getShineiiWatch(slug, epNum);
    if (data) return { ...data, source: 'shineii' };
  } catch (error) {
    console.error('[Waterfall] Fallback 2 (Shineii) watch failed:', error);
  }

  // 4. Fallback 3: Anilist + GogoAnime
  try {
    const data = await getAnilistWatch(slug, epNum);
    if (data) return { ...data, source: 'gogoanime' };
  } catch (error) {
    console.error('[Waterfall] Fallback 3 (GogoAnime) watch failed:', error);
  }

  throw new Error('All waterfall providers failed to fetch watch data for slug: ' + slug + ' ep: ' + epNum);
}
