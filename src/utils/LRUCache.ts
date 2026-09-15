interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Tiny LRU cache with per-entry TTL. O(1) get/set using Map insertion order.
 * Expired entries are dropped lazily, so no timers are needed.
 */
export class LRUCache<K, V> {
  private readonly map = new Map<K, Entry<V>>();
  public hits = 0;
  public misses = 0;

  constructor(
    public readonly maxSize: number,
    public readonly ttlMs: number,
  ) {}

  public get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  public set(key: K, value: V): void {
    if (this.maxSize <= 0) return;
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  public delete(key: K): boolean {
    return this.map.delete(key);
  }

  public clear(): void {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  public get size(): number {
    return this.map.size;
  }
}
