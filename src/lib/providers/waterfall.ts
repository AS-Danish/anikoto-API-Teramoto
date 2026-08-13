import { scrapeAnimeDetail, scrapeAnimeEpisodes, scrapeRelatedAnime } from '../scrapers/anime.scraper';
import { scrapeWatch } from '../scrapers/watch.scraper';
import { getConsumetAnime, getConsumetWatch } from './consumet.provider';
import { getShineiiAnime, getShineiiWatch } from './shineii.provider';
import { getAnilistAnime, getAnilistWatch } from './anilist.provider';

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
    const data = await scrapeWatch(slug, epNum);
    console.log(`[Waterfall] ✅ Anikoto succeeded!`);
    return { ...data, source: 'anikoto' };
  } catch (error) {
    const errObj = error as Error;
    console.error(`[Waterfall] ❌ Primary Anikoto failed: ${errObj.message || 'Unknown error'}`);
  }

  // 2. Fallback 1: Consumet
  try {
    console.log(`[Waterfall] 2. Attempting Consumet...`);
    const data = await getConsumetWatch(slug, epNum);
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
    const data = await getShineiiWatch(slug, epNum);
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
    const data = await getAnilistWatch(slug, epNum);
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
