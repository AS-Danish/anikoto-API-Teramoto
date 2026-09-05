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
  const token = `${Date.now()}-${crypto.randomUUID()}`;
  if (!redisUrl || !redisToken) return token;
  const result = await redisCommand([
    'SET',
    sharedKey(`${LOCK_PREFIX}${key}`),
    token,
    'NX',
    'EX',
    45,
  ]);
  // Redis being unreachable must degrade to the local cache rather than make
  // every cold API request wait for a lock that cannot be inspected.
  if (result === undefined) return token;
  return result === 'OK' ? token : undefined;
}

async function releaseSharedLock(key: string, token: string) {
  if (!redisUrl || !redisToken) return;
  await redisCommand([
    'EVAL',
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
    1,
    sharedKey(`${LOCK_PREFIX}${key}`),
    token,
  ]);
}

async function waitForSharedValue<T>(key: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
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
  refresh = false,
  allowStale = true,
): Promise<T> {
  if (!refresh) {
    const cached = cache.get<T>(key);
    if (cached !== undefined) return cached;
  }

  // Coalesce the entire lookup/fetch pipeline, including shared-cache reads.
  const flightKey = allowStale ? key : `fresh:${key}`;
  const existing = inFlight.get(flightKey);
  if (existing) return existing as Promise<T>;

  const promise = (async () => {
    let stale = cache.get<T>(`${STALE_PREFIX}${key}`);
    let lockToken: string | undefined;

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

      lockToken = await acquireSharedLock(key);
      if (!lockToken) {
        const value = await waitForSharedValue<T>(key);
        if (value !== undefined) {
          memorySet(key, value, ttl);
          memorySet(`${STALE_PREFIX}${key}`, value, Math.max(ttl * 6, 60 * 60));
          return value;
        }
        if (allowStale && stale !== undefined) return stale;
        // The lock owner may be resolving a slow video host or may have died.
        // Try to take over after waiting. If it still owns the lock, continue
        // under the global upstream limiter instead of failing the user.
        lockToken = await acquireSharedLock(key);
      }
    }

    try {
      const fresh = await fetcher();
      memorySet(key, fresh, ttl);
      memorySet(`${STALE_PREFIX}${key}`, fresh, Math.max(ttl * 6, 60 * 60));
      await sharedSet(key, fresh, ttl);
      return fresh;
    } catch (error) {
      if (allowStale && stale !== undefined) return stale;
      throw error;
    } finally {
      if (lockToken) await releaseSharedLock(key, lockToken);
    }
  })().finally(() => {
    inFlight.delete(flightKey);
  });

  inFlight.set(flightKey, promise);
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

/** Atomic shared admission limit; per-instance protection if Redis is absent. */
export async function consumeRateLimit(key: string, limit: number, seconds: number): Promise<boolean> {
  const result = await redisCommand([
    'EVAL',
    'local n=redis.call("INCR",KEYS[1]); if n==1 then redis.call("EXPIRE",KEYS[1],ARGV[1]) end; return n',
    1, sharedKey(`rate:${key}`), seconds,
  ]);
  if (typeof result === 'number') return result <= limit;
  const localKey = `rate:${key}`;
  const entry = cache.get<{ count: number; until: number }>(localKey);
  const now = Date.now();
  const current = entry && entry.until > now ? entry : { count: 0, until: now + seconds * 1000 };
  current.count += 1;
  memorySet(localKey, current, Math.max(1, Math.ceil((current.until - now) / 1000)));
  return current.count <= limit;
}
