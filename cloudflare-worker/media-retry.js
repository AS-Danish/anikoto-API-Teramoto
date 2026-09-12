// Retry before forwarding any bytes. Never splice a restarted response into a
// partially delivered segment, which would corrupt the media stream.
export async function fetchMediaWithRetry(target, options, fetcher = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    let response;
    try {
      response = await fetcher(target, options);
    } catch (error) {
      if (attempt >= 2 || options.signal?.aborted) throw error;
      await wait(250 * (attempt + 1));
      continue;
    }
    if (attempt >= 2 || ![500, 502, 503, 504].includes(response.status)) return response;
    const retryAfter = response.headers.get('retry-after');
    const seconds = retryAfter === null ? 0 : /^\d+$/.test(retryAfter)
      ? Number(retryAfter) : Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000);
    // Long cooldowns belong to the client; don't hold a segment request open.
    if (!Number.isFinite(seconds) || seconds > 3) return response;
    await response.body?.cancel();
    await wait(Math.max(seconds * 1000, 250 * (attempt + 1)));
  }
}
