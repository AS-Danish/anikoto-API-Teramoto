/** Embed pages must never count as native playback/download sources. */
export function hasMediaSource(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const source = value as { proxyUrl?: unknown; m3u8?: unknown; url?: unknown };
  const valid = (url: unknown) => typeof url === 'string' &&
    /^(?:https?:\/\/|\/(?!\/))\S+$/i.test(url.trim());
  return valid(source.proxyUrl) || valid(source.m3u8) ||
    (valid(source.url) && /\.(?:m3u8|mp4|webm|mkv)(?:$|[?#])/i.test(String(source.url)));
}
