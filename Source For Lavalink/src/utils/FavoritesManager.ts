/**
 * FavoritesManager - Manage user/guild favorite tracks
 */

import type { Track } from '../types/lavalink';

interface FavoriteTrack {
  track: Track;
  addedAt: number;
  accessedAt: number; // Track last access for LRU
  addedBy?: string;
}

export class FavoritesManager {
  private userFavorites: Map<string, FavoriteTrack[]> = new Map();
  private guildFavorites: Map<string, FavoriteTrack[]> = new Map();
  private maxPerUser: number;
  private maxPerGuild: number;

  constructor(maxPerUser: number = 100, maxPerGuild: number = 500) {
    this.maxPerUser = maxPerUser;
    this.maxPerGuild = maxPerGuild;
  }

  /**
   * Add track to user favorites (uses LRU eviction)
   */
  addUserFavorite(userId: string, track: Track): boolean {
    if (!this.userFavorites.has(userId)) {
      this.userFavorites.set(userId, []);
    }

    const favorites = this.userFavorites.get(userId)!;
    
    // Check if already exists and update access time
    const existing = favorites.find(f => f.track.encoded === track.encoded);
    if (existing) {
      existing.accessedAt = Date.now();
      return false; // Already exists
    }

    // Check max limit and remove least recently accessed
    if (favorites.length >= this.maxPerUser) {
      const lruIndex = favorites.reduce((minIdx, f, idx, arr) => 
        f.accessedAt < arr[minIdx].accessedAt ? idx : minIdx, 0
      );
      favorites.splice(lruIndex, 1);
    }

    favorites.push({
      track,
      addedAt: Date.now(),
      accessedAt: Date.now(),
    });

    return true;
  }

  /**
   * Add track to guild favorites (uses LRU eviction)
   */
  addGuildFavorite(guildId: string, track: Track, addedBy?: string): boolean {
    if (!this.guildFavorites.has(guildId)) {
      this.guildFavorites.set(guildId, []);
    }

    const favorites = this.guildFavorites.get(guildId)!;
    
    // Check if already exists and update access time
    const existing = favorites.find(f => f.track.encoded === track.encoded);
    if (existing) {
      existing.accessedAt = Date.now();
      return false; // Already exists
    }

    // Check max limit and remove least recently accessed
    if (favorites.length >= this.maxPerGuild) {
      const lruIndex = favorites.reduce((minIdx, f, idx, arr) => 
        f.accessedAt < arr[minIdx].accessedAt ? idx : minIdx, 0
      );
      favorites.splice(lruIndex, 1);
    }

    favorites.push({
      track,
      addedAt: Date.now(),
      accessedAt: Date.now(),
      addedBy,
    });

    return true;
  }

  /**
   * Remove track from user favorites
   */
  removeUserFavorite(userId: string, trackEncoded: string): boolean {
    const favorites = this.userFavorites.get(userId);
    if (!favorites) return false;

    const index = favorites.findIndex(f => f.track.encoded === trackEncoded);
    if (index === -1) return false;

    favorites.splice(index, 1);
    return true;
  }

  /**
   * Remove track from guild favorites
   */
  removeGuildFavorite(guildId: string, trackEncoded: string): boolean {
    const favorites = this.guildFavorites.get(guildId);
    if (!favorites) return false;

    const index = favorites.findIndex(f => f.track.encoded === trackEncoded);
    if (index === -1) return false;

    favorites.splice(index, 1);
    return true;
  }

  /**
   * Get user favorites
   */
  getUserFavorites(userId: string): FavoriteTrack[] {
    return this.userFavorites.get(userId) || [];
  }

  /**
   * Get guild favorites
   */
  getGuildFavorites(guildId: string): FavoriteTrack[] {
    return this.guildFavorites.get(guildId) || [];
  }

  /**
   * Clear user favorites
   */
  clearUserFavorites(userId: string): void {
    this.userFavorites.delete(userId);
  }

  /**
   * Clear guild favorites
   */
  clearGuildFavorites(guildId: string): void {
    this.guildFavorites.delete(guildId);
  }

  /**
   * Export user favorites for persistence
   */
  exportUserFavorites(userId: string): string {
    const favorites = this.getUserFavorites(userId);
    return JSON.stringify(favorites);
  }

  /**
   * Import user favorites from persistence
   */
  importUserFavorites(userId: string, data: string): void {
    try {
      const favorites = JSON.parse(data) as FavoriteTrack[];
      this.userFavorites.set(userId, favorites);
    } catch (error) {
      console.error('Failed to import user favorites:', error);
    }
  }

  /**
   * Export guild favorites for persistence
   */
  exportGuildFavorites(guildId: string): string {
    const favorites = this.getGuildFavorites(guildId);
    return JSON.stringify(favorites);
  }

  /**
   * Import guild favorites from persistence
   */
  importGuildFavorites(guildId: string, data: string): void {
    try {
      const favorites = JSON.parse(data) as FavoriteTrack[];
      this.guildFavorites.set(guildId, favorites);
    } catch (error) {
      console.error('Failed to import guild favorites:', error);
    }
  }
}
