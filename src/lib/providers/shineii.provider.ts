import axios from 'axios';
import { BASE_URL } from '../constants';
import { extractStreamUrl, extractStreamViaWorker } from '../extractors';
import { makeProxyHelper } from '../scrapers/watch.scraper';

const SHINEII_URL = (process.env.SHINEII_URL || 'https://anikototvapi.vercel.app').replace(/\/$/, '');

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export async function getShineiiAnime(slug: string) {
  try {
    const res = await axios.get(`${SHINEII_URL}/api/info?slug=${encodeURIComponent(slug)}`, {
      timeout: 12_000,
    });
    if (!res.data?.success) return null;
    const data = res.data.results;
    return {
      id: data.animeId ? String(data.animeId) : data.id,
      slug,
      title: data.title,
      titleJp: data.japaneseTitle,
      image: data.poster,
      synopsis: data.synopsis,
      type: data.type,
      status: data.status,
      genres: data.genres || [],
      episodeCount: Number.parseInt(data.episodes, 10) || undefined,
      episodes: {
        animeId: data.animeId ? String(data.animeId) : data.id,
        slug,
        episodes: [],
      },
      seasons: data.seasons || [],
    };
  } catch {
    throw new Error('Shineii API fetch failed');
  }
}

export async function getShineiiWatch(slug: string, epNum: string, requestId?: string) {
  try {
    const watchResponse = await axios.get(
      `${SHINEII_URL}/api/watch?slug=${encodeURIComponent(slug)}&ep=${encodeURIComponent(epNum)}`,
      { timeout: 15_000 },
    );
    if (!watchResponse.data?.success) throw new Error('Watch metadata unavailable');
    const watchData = record(watchResponse.data.results);
    const animeId = text(watchData.animeId) || String(watchData.animeId || '');
    if (!animeId) throw new Error('Anime ID unavailable');

    const episodesResponse = await axios.get(
      `${SHINEII_URL}/api/episodes/${encodeURIComponent(animeId)}`,
      { timeout: 15_000 },
    );
    const episodeResults = record(episodesResponse.data?.results);
    const episodes = Array.isArray(episodeResults.episodes) ? episodeResults.episodes : [];
    const selectedEpisode = episodes
      .map(record)
      .find((episode) => String(episode.episode_no) === String(epNum));
    const serverIds = text(selectedEpisode?.server_ids);
    if (!serverIds) throw new Error('Episode server IDs unavailable');

    const serversResponse = await axios.get(`${SHINEII_URL}/api/servers`, {
      params: { ids: serverIds },
      timeout: 15_000,
    });
    const rawServers: JsonRecord[] = Array.isArray(serversResponse.data?.results)
      ? (serversResponse.data.results as unknown[]).map(record)
      : [];
    if (!rawServers.length) throw new Error('No fallback servers available');
    const selectedServer = rawServers.find((server) => text(server.name).toLowerCase().includes('hd'))
      || rawServers[0];
    const linkId = text(selectedServer.link_id) || text(selectedServer.id);
    if (!linkId) throw new Error('Fallback server link ID unavailable');

    const streamResponse = await axios.get(`${SHINEII_URL}/api/stream`, {
      params: { id: linkId },
      timeout: 15_000,
    });
    const streamData = record(streamResponse.data?.results);
    const embedUrl = text(streamData.url);
    if (!embedUrl) throw new Error('Fallback embed URL unavailable');
    const parentReferer = `${BASE_URL}/watch/${slug}/ep-${epNum}`;
    const extracted = await extractStreamUrl(embedUrl, parentReferer)
      || await extractStreamViaWorker(embedUrl, parentReferer, requestId);
    if (!extracted?.m3u8) throw new Error('Fallback embed could not be resolved');

    const getProxyUrl = makeProxyHelper();
    const servers = rawServers.map((server) => ({
      id: text(server.link_id) || text(server.id),
      name: text(server.name) || 'Shineii',
      type: text(server.type) || 'sub',
      svId: text(server.sv_id) || undefined,
    }));
    return {
      episode: {
        number: String(epNum),
        title: text(watchData.title) || `Episode ${epNum}`,
        href: `/watch/${slug}/ep-${epNum}`,
        id: text(selectedEpisode?.id) || undefined,
      },
      servers,
      sources: [{
        server: text(selectedServer.name) || 'Shineii',
        type: text(selectedServer.type) || 'sub',
        url: embedUrl,
        m3u8: extracted.m3u8,
        referer: extracted.referer,
        proxyUrl: getProxyUrl(extracted.m3u8, extracted.referer),
        tracks: extracted.tracks.map((track) => ({
          ...track,
          proxyUrl: getProxyUrl(track.file, extracted.referer),
        })),
      }],
      skip_data: streamData.skipData || {
        intro: extracted.intro,
        outro: extracted.outro,
      },
    };
  } catch {
    throw new Error('Shineii API watch fetch failed');
  }
}
