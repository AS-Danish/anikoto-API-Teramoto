import { randomUUID } from 'node:crypto';

export function playbackDiagnosticsEnabled() {
  return process.env.PLAYBACK_DIAGNOSTICS === 'true';
}

export function playbackRequestId(value?: string | null) {
  const supplied = value?.trim() || '';
  return /^[a-zA-Z0-9_-]{6,80}$/.test(supplied)
    ? supplied
    : randomUUID().replaceAll('-', '').slice(0, 16);
}

export function safeHost(value?: string | null) {
  if (!value) return '';
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function safePlaybackError(error: unknown) {
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  const message = typeof candidate?.message === 'string'
    ? candidate.message
        .replace(/https?:\/\/[^\s"']+/gi, (url) => {
          const host = safeHost(url);
          return host ? `https://${host}/<redacted>` : '<url-redacted>';
        })
        .slice(0, 500)
    : String(error).slice(0, 500);
  return {
    name: typeof candidate?.name === 'string' ? candidate.name : 'Error',
    message,
    code: typeof candidate?.code === 'string' ? candidate.code : undefined,
    status: typeof candidate?.response?.status === 'number'
      ? candidate.response.status
      : undefined,
  };
}

export function playbackLog(
  requestId: string,
  event: string,
  details: Record<string, unknown> = {},
  level: 'info' | 'warn' | 'error' = 'info',
) {
  if (!playbackDiagnosticsEnabled()) return;
  const line = JSON.stringify({
    scope: 'playback',
    requestId,
    event,
    at: new Date().toISOString(),
    ...details,
  });
  if (level === 'error') console.error(`[PlaybackDiag] ${line}`);
  else if (level === 'warn') console.warn(`[PlaybackDiag] ${line}`);
  else console.log(`[PlaybackDiag] ${line}`);
}
