import NodeCache from 'node-cache';

const MAX_MEMORY_KEYS = 5_000;
// Fast per-instance cache. The optional Upstash REST layer below makes the
// same entries reusable across serverless instances and regions.
const cache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  useClones: false,
});

export default cache;

const STALE_PREFIX = '__stale__:';
const LOCK_PREFIX = '__lock__:';
const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const cacheNamespace = process.env.CACHE_NAMESPACE || 'anikoto:v1';

function memorySet<T>(key: string, value: T, ttl: number) {
  if (!cache.has(key) && cache.keys().length >= MAX_MEMORY_KEYS) {
    const oldest = cache.keys()[0];
    if (oldest) cache.del(oldest);
  }
  cache.set(key, value, ttl);
}

type SharedEnvelope<T> = {
  freshUntil: number;
  value: T;
};

function sharedKey(key: string) {
  return `${cacheNamespace}:${key}`;
}

async function redisCommand(command: Array<string | number>) {
  if (!redisUrl || !redisToken) return undefined;
  try {
    const response = await fetch(redisUrl, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { result?: unknown };
    return payload.result;
  } catch {
    // Shared cache failure must never take the API down; local cache remains.
    return undefined;
  }
}

async function sharedGet<T>(key: string): Promise<SharedEnvelope<T> | undefined> {
  const raw = await redisCommand(['GET', sharedKey(key)]);
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as SharedEnvelope<T>;
  } catch {
    return undefined;
  }
}

async function sharedSet<T>(key: string, value: T, ttl: number) {
  const staleTtl = Math.max(ttl * 6, 60 * 60);
  const envelope: SharedEnvelope<T> = {
    freshUntil: Date.now() + ttl * 1_000,
    value,
  };
  await redisCommand([
    'SET',
    sharedKey(key),
    JSON.stringify(envelope),
    'EX',
    staleTtl,
  ]);
}

async function acquireSharedLock(key: string) {
  if (!redisUrl || !redisToken) return true;
  const result = await redisCommand([
    'SET',
    sharedKey(`${LOCK_PREFIX}${key}`),
    `${Date.now()}-${Math.random()}`,
    'NX',
    'EX',
    45,
  ]);
  return result === 'OK';
}

async function waitForSharedValue<T>(key: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const entry = await sharedGet<T>(key);
    if (entry && entry.freshUntil > Date.now()) return entry.value;
  }
  return undefined;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const localUpstreamConcurrency = positiveInteger(
  process.env.UPSTREAM_MAX_CONCURRENCY,
  6,
);
const upstreamRequestsPerSecond = positiveInteger(
  process.env.UPSTREAM_REQUESTS_PER_SECOND,
  8,
);
let activeUpstreamRequests = 0;
let nextUpstreamStart = 0;
const upstreamWaiters: Array<() => void> = [];

async function acquireLocalUpstreamSlot() {
  if (activeUpstreamRequests >= localUpstreamConcurrency) {
    await new Promise<void>((resolve) => upstreamWaiters.push(resolve));
  }
  activeUpstreamRequests += 1;
  const interval = Math.ceil(1_000 / upstreamRequestsPerSecond);
  const now = Date.now();
  const delay = Math.max(0, nextUpstreamStart - now);
  nextUpstreamStart = Math.max(now, nextUpstreamStart) + interval;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

function releaseLocalUpstreamSlot() {
  activeUpstreamRequests = Math.max(0, activeUpstreamRequests - 1);
  upstreamWaiters.shift()?.();
}

async function acquireSharedUpstreamPermit(attempt = 0): Promise<void> {
  if (!redisUrl || !redisToken) return;
  const window = Math.floor(Date.now() / 1_000);
  const key = sharedKey(`upstream-rate:${window}`);
  const created = await redisCommand(['SET', key, 1, 'NX', 'EX', 2]);
  const count = created === 'OK' ? 1 : Number(await redisCommand(['INCR', key]));
  if (!Number.isFinite(count) || count <= upstreamRequestsPerSecond) return;
  if (attempt >= 5) throw new Error('Upstream request budget is temporarily exhausted.');
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  return acquireSharedUpstreamPermit(attempt + 1);
}

/** Limits actual source-site traffic, including cold requests for different keys. */
export async function withUpstreamLimit<T>(operation: () => Promise<T>): Promise<T> {
  await acquireLocalUpstreamSlot();
  try {
    await acquireSharedUpstreamPermit();
    return await operation();
  } finally {
    releaseLocalUpstreamSlot();
  }
}

/**
 * In-flight promise map for stampede protection.
 * When multiple concurrent requests hit a cold cache key simultaneously,
 * only one fetcher() call is made; all waiters share the same promise.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Get-or-set cache helper.
 * Calls `fetcher` only when `key` is missing/expired; stores the result with `ttl` seconds.
 * Concurrent requests for the same cold key share a single in-flight fetch (no thundering herd).
 */
export async function getOrSet<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number,
  refresh = false
): Promise<T> {
  if (!refresh) {
    const cached = cache.get<T>(key);
    if (cached !== undefined) return cached;
  }

  // Coalesce the entire lookup/fetch pipeline, including shared-cache reads.
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = (async () => {
    let stale = cache.get<T>(`${STALE_PREFIX}${key}`);

    if (!refresh) {
      const shared = await sharedGet<T>(key);
      if (shared) {
        stale = shared.value;
        memorySet(`${STALE_PREFIX}${key}`, shared.value, Math.max(ttl * 6, 60 * 60));
        if (shared.freshUntil > Date.now()) {
          memorySet(key, shared.value, ttl);
          return shared.value;
        }
      }

      const ownsLock = await acquireSharedLock(key);
      if (!ownsLock) {
        const value = await waitForSharedValue<T>(key);
        if (value !== undefined) {
          memorySet(key, value, ttl);
          memorySet(`${STALE_PREFIX}${key}`, value, Math.max(ttl * 6, 60 * 60));
          return value;
        }
        if (stale !== undefined) return stale;
        throw new Error('A shared refresh is still in progress.');
      }
    }

    try {
      const fresh = await fetcher();
      memorySet(key, fresh, ttl);
      memorySet(`${STALE_PREFIX}${key}`, fresh, Math.max(ttl * 6, 60 * 60));
      await sharedSet(key, fresh, ttl);
      return fresh;
    } catch (error) {
      if (stale !== undefined) return stale;
      throw error;
    }
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return promise;
}

/** Read a value directly from cache without triggering a fetch. Returns undefined on miss. */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const local = cache.get<T>(key);
  if (local !== undefined) return local;
  const shared = await sharedGet<T>(key);
  if (!shared || shared.freshUntil <= Date.now()) return undefined;
  memorySet(key, shared.value, Math.max(1, Math.ceil((shared.freshUntil - Date.now()) / 1_000)));
  return shared.value;
}

/** Write a value directly into cache. */
export async function cacheSet<T>(key: string, value: T, ttl: number): Promise<void> {
  memorySet(key, value, ttl);
  memorySet(`${STALE_PREFIX}${key}`, value, Math.max(ttl * 6, 60 * 60));
  await sharedSet(key, value, ttl);
}
