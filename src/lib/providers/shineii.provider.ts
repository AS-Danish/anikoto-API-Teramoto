import axios from 'axios';

// Ensure you set this in your Vercel Environment Variables later
const SHINEII_URL = process.env.SHINEII_URL || 'https://your-shineii-deployment.vercel.app';

export async function getShineiiAnime(slug: string) {
  try {
    // Shineii uses /api/info?slug= instead of /api/anime/[slug]
    const res = await axios.get(`${SHINEII_URL}/api/info?slug=${slug}`);
    
    // Shineii uses { success: true, results: ... } instead of { ok: true, data: ... }
    if (res.data && res.data.success) {
      const data = res.data.results;
      
      // Map Shineii's fields back to our Next.js expected format if necessary
      return {
        id: data.animeId ? String(data.animeId) : data.id,
        slug: slug,
        title: data.title,
        titleJp: data.japaneseTitle,
        image: data.poster,
        synopsis: data.synopsis,
        type: data.type,
        status: data.status,
        genres: data.genres || [],
        episodeCount: parseInt(data.episodes, 10) || undefined,
        // Mock episodes list if not fully returned by /info
        episodes: {
          animeId: data.animeId ? String(data.animeId) : data.id,
          slug: slug,
          episodes: Array.from({ length: parseInt(data.episodes, 10) || 12 }).map((_, i) => ({
            id: `ep-${i + 1}`,
            number: String(i + 1),
            title: `Episode ${i + 1}`,
            href: `/watch/${slug}?ep=${i + 1}`
          }))
        },
        seasons: data.seasons || []
      };
    }
  } catch (error) {
    throw new Error('Shineii API fetch failed');
  }
  return null;
}

export async function getShineiiWatch(slug: string, epNum: string) {
  try {
    // 1. Fetch watch page to get server IDs
    const watchRes = await axios.get(`${SHINEII_URL}/api/watch?slug=${slug}&ep=${epNum}`);
    if (!watchRes.data || !watchRes.data.success) {
      throw new Error('Shineii API watch page fetch failed');
    }

    const watchData = watchRes.data.results;
    const servers = watchData.servers || [];
    
    if (servers.length === 0) {
      throw new Error('No servers found on Shineii');
    }

    // Grab the best server linkId (Sub or Dub HD if possible)
    let bestServer = servers.find((s: any) => s.type === 'sub' && s.name.includes('HD-1'));
    if (!bestServer) bestServer = servers[0];
    const linkId = bestServer.linkId || bestServer.id;

    // 2. Resolve the stream URL using the linkId
    const streamRes = await axios.get(`${SHINEII_URL}/api/stream/resolve?id=${linkId}`);
    if (!streamRes.data || !streamRes.data.success) {
      throw new Error('Shineii API stream resolution failed');
    }
    
    const streamData = streamRes.data.results;

    // Format back to Anikoto Next.js JSON format
    return {
      episode: {
        number: String(epNum),
        title: watchData.title || `Episode ${epNum}`
      },
      servers: servers,
      stream: {
        sources: [
          { url: streamData.url, quality: 'auto' }
        ],
        subtitles: streamData.subtitles || [],
      }
    };
  } catch (error) {
    throw new Error('Shineii API watch fetch failed');
  }
}

