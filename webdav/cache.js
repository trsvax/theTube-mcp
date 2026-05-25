// Shared cache for all providers
const cache = new Map();
const CACHE_TTL = 60_000;

export function cached(key, fn) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.value;
  const promise = fn();
  promise.then(v => cache.set(key, { value: Promise.resolve(v), ts: Date.now() }));
  cache.set(key, { value: promise, ts: Date.now() });
  return promise;
}

export function clearCache() {
  cache.clear();
}
