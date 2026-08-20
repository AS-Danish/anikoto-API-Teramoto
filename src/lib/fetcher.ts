import axios from 'axios';
import * as cheerio from 'cheerio';
import { BASE_URL, DEFAULT_HEADERS } from './constants';
import cache, { getOrSet, withUpstreamLimit } from './cache';

/**
 * Fetch an HTML page from anikototv.to and return a Cheerio instance.
 * Raw HTML is cached in memory to optimize parallel requests to the same page.
 */
export async function fetchPage(
  path: string,
  extraHeaders?: Record<string, string>,
  refresh?: boolean
): Promise<cheerio.CheerioAPI> {
  const cacheKey = `html:${path}`;
  if (refresh) {
    cache.del(cacheKey);
  }

  const html = await getOrSet(
    cacheKey,
    async () => {
      let url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
      if (refresh) {
        url += url.includes('?') ? `&_t=${Date.now()}` : `?_t=${Date.now()}`;
      }
      const { data } = await withUpstreamLimit(() => axios.get(url, {
          headers: {
            ...DEFAULT_HEADERS,
            ...(refresh ? { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' } : {}),
            ...extraHeaders,
          },
          timeout: 15_000,
        }));
      return data as string;
    },
    300,
    refresh
  );

  return cheerio.load(html);
}

/**
 * Fetch JSON from the site's internal AJAX endpoints.
 * @param extraHeaders - Optional additional headers to merge (e.g. a per-request Referer).
 */
export async function fetchJson<T = unknown>(
  path: string,
  extraHeaders?: Record<string, string>,
  refresh?: boolean
): Promise<T> {
  let url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  if (refresh) {
    url += url.includes('?') ? `&_t=${Date.now()}` : `?_t=${Date.now()}`;
  }
  const { data } = await withUpstreamLimit(() => axios.get<T>(url, {
      headers: {
        ...DEFAULT_HEADERS,
        Accept: 'application/json, text/javascript, */*',
        'X-Requested-With': 'XMLHttpRequest',
        ...(refresh ? { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' } : {}),
        ...extraHeaders,
      },
      timeout: 15_000,
    }));
  return data;
}
