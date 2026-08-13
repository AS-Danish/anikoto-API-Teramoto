import { makeProxyHelper } from '../scrapers/watch.scraper';
import axios from 'axios';

// Public Consumet instance for Gogoanime
const CONSUMET_URL = process.env.CONSUMET_URL || 'https://api.consumet.org/anime/gogoanime';

export async function getConsumetAnime(slug: string) {
  try {
    // 1. Search for the anime by slug/title
    const searchRes = await axios.get(`${CONSUMET_URL}/${slug}`);
    if (!searchRes.data || !searchRes.data.results || searchRes.data.results.length === 0) {
      throw new Error('Anime not found on Consumet');
    }

    const firstResult = searchRes.data.results[0];
    const consumetId = firstResult.id;

    // 2. Fetch anime info
    const infoRes = await axios.get(`${CONSUMET_URL}/info/${consumetId}`);
    const info = infoRes.data;

    // Format to match Anikoto
    return {
      id: info.id,
      slug: slug,
      title: info.title,
      image: info.image,
      synopsis: info.description,
      premiered: info.releaseDate,
      status: info.status,
      genres: info.genres || [],
      type: info.type,
      episodeCount: info.totalEpisodes,
      episodes: {
        animeId: info.id,
        slug: slug,
        episodes: (info.episodes || []).map((ep: any) => ({
          id: ep.id,
          number: String(ep.number),
          title: ep.title,
          href: `/watch/${slug}?ep=${ep.number}`
        }))
      },
      seasons: []
    };
  } catch (error) {
    throw new Error('Consumet API fetch failed');
  }
}

export async function getConsumetWatch(slug: string, epNum: string) {
  try {
    const searchRes = await axios.get(`${CONSUMET_URL}/${slug}`);
    if (!searchRes.data || !searchRes.data.results || searchRes.data.results.length === 0) {
      throw new Error('Anime not found on Consumet');
    }

    const consumetId = searchRes.data.results[0].id;
    const infoRes = await axios.get(`${CONSUMET_URL}/info/${consumetId}`);
    const episodes = infoRes.data.episodes || [];
    
    const episode = episodes.find((ep: any) => String(ep.number) === String(epNum));
    if (!episode) throw new Error('Episode not found on Consumet');

    const watchRes = await axios.get(`${CONSUMET_URL}/watch/${episode.id}`);
    
    const getProxyUrl = makeProxyHelper();
    const referer = watchRes.data.headers?.Referer || "https://gogoanime.co/";
    // Format to match Anikoto Watch JSON
    return {
      stream: {
        sources: (watchRes.data.sources || []).map((s: any) => ({
          url: s.url,
          quality: s.quality || 'auto',
          proxyUrl: getProxyUrl(s.url, referer)
        })),
        subtitles: [],
        intro: watchRes.data.intro || undefined,
        outro: watchRes.data.outro || undefined
      }
    };
  } catch (error) {
    throw new Error('Consumet API watch fetch failed');
  }
}
