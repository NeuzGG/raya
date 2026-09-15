/**
 * MetadataCache - Cache track metadata to reduce API calls
 */

import type { Track } from '../types/lavalink';

interface CacheEntry {
  track: Track;
  timestamp: number;
}

export class MetadataCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxSize: number;
  private ttl: number; // Time to live in ms
  private cleanupInterval: NodeJS.Timeout | null = null;
  private cleanupIntervalMs: number = 300000; // 5 minutes

  // Cache metrics
  private hitCount: number = 0;
  private missCount: number = 0;
  private evictionCount: number = 0;
  private sessionStartTime: number = Date.now();

  constructor(maxSize: number = 1000, ttl: number = 3600000) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.startAutoCleanup();
  }

  /**
   * Start automatic cleanup interval
   */
  private startAutoCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);
    // Allow process to exit even if interval is running
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Stop automatic cleanup
   */
  public stopAutoCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get track from cache
   */
  get(identifier: string): Track | null {
    const entry = this.cache.get(identifier);
    if (!entry) {
      this.missCount++;
      return null;
    }

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(identifier);
      this.missCount++;
      return null;
    }

    this.hitCount++;
    return entry.track;
  }

  /**
   * Set track in cache
   */
  set(identifier: string, track: Track): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
        this.evictionCount++;
      }
    }

    this.cache.set(identifier, {
      track,
      timestamp: Date.now(),
    });
  }

  /**
   * Check if track exists in cache
   */
  has(identifier: string): boolean {
    return this.get(identifier) !== null;
  }

  /**
   * Clear expired entries
   */
  cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      console.debug(`MetadataCache: Cleaned up ${removed} expired entries`);
    }
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Get cache metrics (hit/miss stats)
   */
  getMetrics(): {
    hits: number;
    misses: number;
    evictions: number;
    totalRequests: number;
    hitRate: number;
    currentSize: number;
    maxSize: number;
    sessionDuration: number;
  } {
    const totalRequests = this.hitCount + this.missCount;
    const hitRate = totalRequests > 0 ? (this.hitCount / totalRequests) * 100 : 0;
    const sessionDuration = Date.now() - this.sessionStartTime;

    return {
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
      totalRequests,
      hitRate: Math.round(hitRate * 100) / 100, // Round to 2 decimals
      currentSize: this.cache.size,
      maxSize: this.maxSize,
      sessionDuration,
    };
  }

  /**
   * Reset cache metrics
   */
  resetMetrics(): void {
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
    this.sessionStartTime = Date.now();
  }

  /**
   * Destroy cache and cleanup resources
   */
  destroy(): void {
    this.stopAutoCleanup();
    this.clear();
  }
}
