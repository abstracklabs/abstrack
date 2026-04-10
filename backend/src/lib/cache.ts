/**
 * Cache TTL en mémoire — zéro dépendance.
 *
 * Conçu pour les endpoints lus fréquemment (live-sales, global, trending).
 * Pas de LRU ni d'éviction complexe : le nombre de clés est borné et connu.
 *
 * Usage :
 *   const data = await withCache('analytics:global', 30_000, () => db.queryOne(...))
 */

interface CacheEntry<T> {
  data: T
  expires: number
}

const _store = new Map<string, CacheEntry<unknown>>()

export function cacheGet<T>(key: string): T | null {
  const entry = _store.get(key)
  if (!entry) return null
  if (Date.now() > entry.expires) {
    _store.delete(key)
    return null
  }
  return entry.data as T
}

export function cacheSet<T>(key: string, data: T, ttlMs: number): void {
  _store.set(key, { data, expires: Date.now() + ttlMs })
}

export function cacheInvalidate(prefix: string): void {
  for (const key of _store.keys()) {
    if (key.startsWith(prefix)) _store.delete(key)
  }
}

/**
 * Cache-aside : retourne le cache si valide, sinon exécute fn() et met en cache.
 * Pas de stampede protection — acceptable pour ce volume de trafic MVP.
 */
export async function withCache<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const cached = cacheGet<T>(key)
  if (cached !== null) return cached

  const data = await fn()
  cacheSet(key, data, ttlMs)
  return data
}
