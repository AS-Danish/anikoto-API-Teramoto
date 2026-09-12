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

export type MegaplayCipherConfig = { key: string; iv: string };

/**
 * Read the current cipher material from MegaPlay's public browser client.
 * These values are transport-obfuscation parameters, not application secrets.
 */
export function megaplayCipherConfig(clientScript: string): MegaplayCipherConfig | null {
  const match = clientScript.match(
    /["']use strict["'];var\s+[$\w]+="([^"]{16,64})",[$\w]+="([^"]{16,32})",[$\w]+=\/\\\/segment\\\//,
  );
  return match ? { key: match[1], iv: match[2] } : null;
}

function base64UrlBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function paddedUtf8(value: string, length: number): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const result = new Uint8Array(length);
  result.set(encoded.subarray(0, length));
  return result;
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export async function decryptMegaplayCiphertext(
  encrypted: string,
  config: MegaplayCipherConfig,
): Promise<string> {
  if (config.iv.length !== 16) throw new Error('Invalid MegaPlay cipher IV');
  const key = await crypto.subtle.importKey(
    'raw',
    exactArrayBuffer(paddedUtf8(config.key, 32)),
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: exactArrayBuffer(paddedUtf8(config.iv, 16)) },
    key,
    exactArrayBuffer(base64UrlBytes(encrypted)),
  );
  return new TextDecoder().decode(plaintext);
}

export async function decryptMegaplaySource(
  encrypted: string,
  clientScript: string,
): Promise<unknown> {
  const config = megaplayCipherConfig(clientScript);
  if (!config) throw new Error('MegaPlay client did not expose a supported cipher configuration');
  return JSON.parse(await decryptMegaplayCiphertext(encrypted, config));
}
