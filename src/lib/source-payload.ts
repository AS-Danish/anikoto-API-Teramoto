import { parseSafeMediaTarget } from './proxy-security';

/** Provider payloads vary between an object, array, and JSON-encoded values. */
export function sourceMediaUrl(value: unknown, depth = 0): string | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') {
    const safe = parseSafeMediaTarget(value);
    if (safe) return safe.href;
    try { return sourceMediaUrl(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const source of value) {
      const media = sourceMediaUrl(source, depth + 1);
      if (media) return media;
    }
    return null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return sourceMediaUrl(record.file ?? record.url ?? record.sources, depth + 1);
  }
  return null;
}

export function encryptedSourceValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) return encryptedSourceValue(value[0]);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return typeof record.file === 'string' ? record.file : null;
  }
  return null;
}
