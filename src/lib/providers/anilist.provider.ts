import { makeProxyHelper } from '../scrapers/watch.scraper';
import axios from 'axios';

const ANILIST_API_URL = 'https://graphql.anilist.co';
const GOGOANIME_CONSUMET_URL = process.env.GOGO_URL || 'https://api.consumet.org/anime/gogoanime';

export async function getAnilistAnime(slug: string) {
  // Try to clean the slug for searching
  const searchQuery = slug.replace(/-[a-z0-9]+$/, '').replace(/-/g, ' ');

  const query = `
    query ($search: String) {
      Media (search: $search, type: ANIME) {
        id
        title {
          romaji
          english
          native
        }
        description
        coverImage {
          extraLarge
        }
        startDate {
          year
        }
        status
        genres
        format
        episodes
      }
    }
  `;

  try {
    const res = await axios.post(ANILIST_API_URL, {
      query,
      variables: { search: searchQuery }
    });

    const media = res.data?.data?.Media;
    if (!media) throw new Error('Not found on Anilist');

    return {
      id: String(media.id),
      slug: slug,
      title: media.title.english || media.title.romaji,
      image: media.coverImage?.extraLarge,
      synopsis: media.description,
      premiered: media.startDate?.year ? String(media.startDate.year) : undefined,
      status: media.status,
      genres: media.genres || [],
      type: media.format,
      episodeCount: media.episodes,
      episodes: {
        animeId: String(media.id),
        slug: slug,
        // Since Anilist doesn't return an episode array, we mock it based on episode count
        episodes: Array.from({ length: media.episodes || 12 }).map((_, i) => ({
          id: `ep-${i + 1}`,
          number: String(i + 1),
          title: `Episode ${i + 1}`,
          href: `/watch/${slug}?ep=${i + 1}`
        }))
      },
      seasons: []
    };
  } catch (error) {
    throw new Error('Anilist API fetch failed');
  }
}

export async function getAnilistWatch(slug: string, epNum: string) {
  // Use a secondary Consumet instance for GogoAnime streams as the final fallback
  try {
    const searchRes = await axios.get(`${GOGOANIME_CONSUMET_URL}/${slug}`);
    if (!searchRes.data || !searchRes.data.results || searchRes.data.results.length === 0) {
      throw new Error('Anime not found on GogoAnime Fallback');
    }

    const gogoId = searchRes.data.results[0].id;
    const infoRes = await axios.get(`${GOGOANIME_CONSUMET_URL}/info/${gogoId}`);
    const episodes = infoRes.data.episodes || [];
    
    const episode = episodes.find((ep: any) => String(ep.number) === String(epNum));
    if (!episode) throw new Error('Episode not found on GogoAnime Fallback');

    const watchRes = await axios.get(`${GOGOANIME_CONSUMET_URL}/watch/${episode.id}`);
    
    const getProxyUrl = makeProxyHelper();
    const referer = watchRes.data.headers?.Referer || "https://gogoanime.co/";

    return {
      stream: {
        sources: (watchRes.data.sources || []).map((s: any) => ({
          url: s.url,
          quality: s.quality || 'auto',
          proxyUrl: getProxyUrl(s.url, referer)
        })),
        subtitles: [],
      }
    };
  } catch (error) {
    throw new Error('Anilist/GogoAnime API watch fetch failed');
  }
}
