/**
 * Player class - Manages audio playback for a guild
 * Handles v4 REST API operations, filters, and queue management
 */

import { FilterBuilder } from './FilterBuilder';
import { AutoPlay } from '../utils/autoplay';
import type { Node } from '../nodes/Node';
import type { LavalinkEventEmitter } from '../manager/events';
import type {
  PlayerOptions,
  Track,
  FilterOptions,
  VoiceState,
  LoadResult,
  SearchPlatformType,
} from '../types/lavalink';

export interface PlayerState {
  volume: number;
  paused: boolean;
  position: number;
  connected: boolean;
  ping: number;
}

export class Player {
  public readonly guildId: string;
  public readonly voiceChannelId: string;
  public textChannelId?: string;

  public node: Node;
  public track: Track | null = null;
  public volume: number = 100;
  public paused: boolean = false;
  public position: number = 0;
  public connected: boolean = false;
  public ping: number = 0;
  public voiceState: Partial<VoiceState> = {};

  public queue: Track[] = [];
  public previousTracks: Track[] = [];
  public history: Track[] = [];

  // Loop modes
  public loopMode: 'off' | 'track' | 'queue' = 'off';
  
  // Crossfade settings
  public crossfadeDuration: number = 0; // ms
  
  // Volume normalization
  public volumeNormalization: boolean = false;
  private currentFilters: FilterOptions = {};

  // Queue size limits
  public maxQueueSize: number = 1000;
  
  // Rate limiting for API calls (Lavalink can handle ~10/s, but being conservative)
  public apiRateLimitDelay: number = 50; // ms between searches - reduced from 100ms for faster playback
  private lastSearchTime: number = 0;

  // Performance metrics
  private tracksPlayed: number = 0;
  private errorCount: number = 0;
  private totalPlaybackTime: number = 0;
  private sessionStartTime: number = Date.now();

  // History stats
  private skippedTracks: number = 0;
  private repeatTracks: Set<string> = new Set();

  // Hooks
  private beforePlayHook: ((track: Track) => Promise<void>) | null = null;
  private afterPlayHook: ((track: Track) => Promise<void>) | null = null;

  private filterBuilder: FilterBuilder;
  private autoPlayEngine: AutoPlay;
  public eventEmitter: LavalinkEventEmitter;
  private autoPlay: boolean;
  private defaultSearchPlatform: SearchPlatformType;
  // Configuration flags (not currently used directly; kept for future use)
  private readonly selfDeafen: boolean;
  private readonly selfMute: boolean;
  private positionUpdateInterval: NodeJS.Timeout | null = null;
  private historyMaxSize: number = 50;

  constructor(
    options: PlayerOptions,
    node: Node,
    eventEmitter: LavalinkEventEmitter,
    autoPlay: boolean = true,
    defaultSearchPlatform: SearchPlatformType = 'ytsearch',
    config?: {
      maxQueueSize?: number;
      apiRateLimitDelay?: number;
    }
  ) {
    this.guildId = options.guildId;
    this.voiceChannelId = options.voiceChannelId;
    this.textChannelId = options.textChannelId;
    this.volume = options.volume ?? 100;
    this.selfDeafen = options.selfDeafen ?? false;
    this.selfMute = options.selfMute ?? false;

    // Apply configuration if provided
    if (config?.maxQueueSize !== undefined) {
      this.maxQueueSize = config.maxQueueSize;
    }
    if (config?.apiRateLimitDelay !== undefined) {
      this.apiRateLimitDelay = config.apiRateLimitDelay;
    }

    this.node = node;
    this.eventEmitter = eventEmitter;
    this.autoPlay = autoPlay;
    this.defaultSearchPlatform = defaultSearchPlatform;
    this.filterBuilder = new FilterBuilder(this);
    this.autoPlayEngine = new AutoPlay();
  }

  // ==================== Event Emission ====================

  /**
   * Emit a debug event
   */
  public emit(event: string, message: string): void {
    this.eventEmitter.emit(event as any, message);
  }

  // ==================== Performance Metrics ====================

  /**
   * Get performance metrics for this player session
   */
  public getMetrics(): {
    tracksPlayed: number;
    errorCount: number;
    totalPlaybackTime: number;
    sessionDuration: number;
    uptime: number;
    avgTracksPerMinute: number;
  } {
    const now = Date.now();
    const sessionDuration = now - this.sessionStartTime;
    const minutes = sessionDuration / 60000;

    return {
      tracksPlayed: this.tracksPlayed,
      errorCount: this.errorCount,
      totalPlaybackTime: this.totalPlaybackTime,
      sessionDuration,
      uptime: sessionDuration,
      avgTracksPerMinute: this.tracksPlayed / Math.max(1, minutes),
    };
  }

  /**
   * Reset performance metrics
   */
  public resetMetrics(): void {
    this.tracksPlayed = 0;
    this.errorCount = 0;
    this.totalPlaybackTime = 0;
    this.sessionStartTime = Date.now();
  }

  /**
   * Increment track played counter
   */
  private incrementTracksPlayed(): void {
    this.tracksPlayed++;
  }

  // ==================== Hooks ====================

  /**
   * Register a beforePlay hook (runs before a track starts playing)
   */
  public onBeforePlay(hook: (track: Track) => Promise<void>): void {
    this.beforePlayHook = hook;
    this.eventEmitter.emit('debug', '✓ beforePlay hook registered');
  }

  /**
   * Register an afterPlay hook (runs after a track starts playing)
   */
  public onAfterPlay(hook: (track: Track) => Promise<void>): void {
    this.afterPlayHook = hook;
    this.eventEmitter.emit('debug', '✓ afterPlay hook registered');
  }

  /**
   * Clear all hooks
   */
  public clearHooks(): void {
    this.beforePlayHook = null;
    this.afterPlayHook = null;
  }

  // ==================== History ====================

  /**
   * Get playback history
   */
  public getHistory(): Track[] {
    return [...this.history];
  }

  /**
   * Get history stats (skips, repeats, unique tracks)
   */
  public getHistoryStats(): {
    totalPlayed: number;
    skipped: number;
    unique: number;
    repeated: number;
  } {
    return {
      totalPlayed: this.history.length,
      skipped: this.skippedTracks,
      unique: new Set(this.history.map(t => t.encoded)).size,
      repeated: this.repeatTracks.size,
    };
  }

  /**
   * Clear playback history and stats
   */
  public clearHistory(): void {
    this.history = [];
    this.skippedTracks = 0;
    this.repeatTracks.clear();
  }

  /**
   * Increment error counter
   */
  private incrementErrorCount(): void {
    this.errorCount++;
  }

  /**
   * Configure API rate limit delay
   * Lower values = faster searches but more server load
   * Default is 50ms. Lavalink can typically handle 10+ requests/sec
   */
  public setApiRateLimit(delayMs: number): void {
    if (delayMs < 0) {
      throw new Error('Rate limit delay cannot be negative');
    }
    this.apiRateLimitDelay = delayMs;
    this.eventEmitter.emit('debug', `API rate limit set to ${delayMs}ms`);
  }

  // ==================== Connection Management ====================

  /**
   * Connect to the voice channel
   */
  public async connect(): Promise<void> {
    this.eventEmitter.emit('debug', `Player connecting to guild ${this.guildId}`);
    // Reference configuration flags to avoid unused warnings and document intent
    const _config = { selfDeafen: this.selfDeafen, selfMute: this.selfMute };
    void _config;
    // Voice connection is handled by VoiceForwarder in Manager
    // This just marks the player as ready to receive voice state updates
  }

  /**
   * Disconnect from the voice channel
   */
  public async disconnect(): Promise<void> {
    this.connected = false;
    this.clearPositionUpdate();
    this.eventEmitter.emit('debug', `Player disconnected from guild ${this.guildId}`);
  }

  /**
   * Destroy the player and clean up resources
   */
  public async destroy(): Promise<void> {
    await this.stop();
    await this.disconnect();
    await this.node.destroyPlayer(this.guildId);
    this.eventEmitter.emit('playerDestroy', this);
  }

  // ==================== Playback Control ====================

  /**
   * Play a track
   */
  public async play(track?: Track, options?: { startTime?: number; endTime?: number; noReplace?: boolean }): Promise<void> {
    try {
      const trackToPlay = track || this.queue.shift();
      
      if (!trackToPlay) {
        throw new Error('No track provided and queue is empty');
      }

      // Check if node is connected before attempting to play
      if (!this.node.isConnected()) {
        this.eventEmitter.emit('debug', `⚠ Cannot play track: Node ${this.node.options.name} is not connected`);
        throw new Error(`Node ${this.node.options.name} is not connected`);
      }

      this.track = trackToPlay;
      this.incrementTracksPlayed();

      // Call beforePlay hook
      if (this.beforePlayHook) {
        try {
          await this.beforePlayHook(trackToPlay);
        } catch (error) {
          this.eventEmitter.emit('debug', `⚠ beforePlay hook error: ${error instanceof Error ? error.message : 'Unknown'}`);
        }
      }

      await this.node.updatePlayer(
        this.guildId,
        {
          track: {
            encoded: trackToPlay.encoded,
            userData: trackToPlay.userData,
          },
          position: options?.startTime,
          endTime: options?.endTime,
        },
        options?.noReplace ?? false
      );

      this.startPositionUpdate();
      this.eventEmitter.emit('debug', `Playing track: ${trackToPlay.info.title}`);

      // Call afterPlay hook
      if (this.afterPlayHook) {
        try {
          await this.afterPlayHook(trackToPlay);
        } catch (error) {
          this.eventEmitter.emit('debug', `⚠ afterPlay hook error: ${error instanceof Error ? error.message : 'Unknown'}`);
        }
      }
    } catch (error) {
      this.incrementErrorCount();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.eventEmitter.emit('debug', `✗ Error playing track: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Pause playback
   */
  public async pause(pause: boolean = true): Promise<void> {
    if (!this.node.isConnected()) {
      const action = pause ? 'pause' : 'resume';
      this.eventEmitter.emit('debug', `⚠ Cannot ${action}: Node ${this.node.options.name} is not connected`);
      throw new Error(`Node ${this.node.options.name} is not connected`);
    }
    await this.node.updatePlayer(this.guildId, { paused: pause });
    this.paused = pause;
    this.eventEmitter.emit('debug', `Player ${pause ? 'paused' : 'resumed'}`);
  }

  /**
   * Resume playback
   */
  public async resume(): Promise<void> {
    await this.pause(false);
  }

  /**
   * Stop playback
   */
  public async stop(): Promise<void> {
    if (!this.node.isConnected()) {
      this.eventEmitter.emit('debug', `⚠ Cannot stop: Node ${this.node.options.name} is not connected`);
      // Still update local state even if node is disconnected
      this.track = null;
      this.position = 0;
      this.clearPositionUpdate();
      return;
    }
    await this.node.updatePlayer(this.guildId, { encodedTrack: null });
    this.track = null;
    this.position = 0;
    this.clearPositionUpdate();
    this.eventEmitter.emit('debug', 'Player stopped');
  }

  /**
   * Seek to a position in the current track
   */
  public async seek(position: number): Promise<void> {
    if (!this.track) {
      throw new Error('No track is currently playing');
    }

    if (position < 0 || position > this.track.info.length) {
      throw new Error('Position out of bounds');
    }

    if (!this.node.isConnected()) {
      this.eventEmitter.emit('debug', `⚠ Cannot seek: Node ${this.node.options.name} is not connected`);
      throw new Error(`Node ${this.node.options.name} is not connected`);
    }

    await this.node.updatePlayer(this.guildId, { position });
    this.position = position;
    this.eventEmitter.emit('debug', `Seeked to position: ${position}ms`);
  }

  /**
   * Set the volume (0-100)
   */
  public async setVolume(volume: number): Promise<void> {
    if (volume < 0 || volume > 100) {
      throw new Error('Volume must be between 0 and 100');
    }

    if (!this.node.isConnected()) {
      this.eventEmitter.emit('debug', `⚠ Cannot set volume: Node ${this.node.options.name} is not connected`);
      throw new Error(`Node ${this.node.options.name} is not connected`);
    }

    // Lavalink v4 accepts volume as 0-1000, but we expose 0-100 for better UX
    const lavalinkVolume = Math.floor(volume * 10);
    await this.node.updatePlayer(this.guildId, { volume: lavalinkVolume });
    this.volume = volume;
    this.eventEmitter.emit('debug', `Volume set to: ${volume}%`);
  }

  // ==================== Filter Management ====================

  /**
   * Get the filter builder for chainable filter configuration
   */
  public filters(): FilterBuilder {
    return this.filterBuilder;
  }

  /**
   * Set filters directly
   */
  public async setFilters(filters: FilterOptions): Promise<void> {
    await this.node.updatePlayer(this.guildId, { filters });
    this.currentFilters = { ...filters };
    this.filterBuilder.setFilters(this.currentFilters);
    this.eventEmitter.emit('debug', 'Filters updated');
  }

  /**
   * Clear all filters
   */
  public async clearFilters(): Promise<void> {
    await this.setFilters({});
    this.filterBuilder.clear();
    this.currentFilters = {};
    this.eventEmitter.emit('debug', 'Filters cleared');
  }

  // ==================== Queue Management ====================

  /**
   * Add a track to the queue
   * Returns false if queue is at max size
   */
  public addTrack(track: Track): boolean {
    if (this.queue.length >= this.maxQueueSize) {
      this.eventEmitter.emit('debug', `Queue is full (max: ${this.maxQueueSize})`);
      return false;
    }
    this.queue.push(track);
    this.eventEmitter.emit('queueChanged', { action: 'add', track, queueLength: this.queue.length });
    return true;
  }

  /**
   * Add multiple tracks to the queue
   * Returns number of tracks actually added (may be less than requested if queue is full)
   */
  public addTracks(tracks: Track[]): number {
    const available = this.maxQueueSize - this.queue.length;
    const toAdd = Math.min(available, tracks.length);
    if (toAdd < tracks.length) {
      this.eventEmitter.emit('debug', `Queue full: added ${toAdd}/${tracks.length} tracks`);
    }
    this.queue.push(...tracks.slice(0, toAdd));
    this.eventEmitter.emit('queueChanged', { action: 'addBatch', count: toAdd, queueLength: this.queue.length });
    return toAdd;
  }

  /**
   * Add a track to the front of the queue (play next)
   */
  public playNext(track: Track): boolean {
    if (this.queue.length >= this.maxQueueSize) {
      this.eventEmitter.emit('debug', `Queue is full (max: ${this.maxQueueSize})`);
      return false;
    }
    this.queue.unshift(track);
    this.eventEmitter.emit('queueChanged', { action: 'playNext', track, queueLength: this.queue.length });
    return true;
  }

  /**
   * Move a track from one position to another within the queue
   */
  public moveTrack(fromIndex: number, toIndex: number): boolean {
    if (
      fromIndex < 0 ||
      fromIndex >= this.queue.length ||
      toIndex < 0 ||
      toIndex >= this.queue.length
    ) {
      return false;
    }
    if (fromIndex === toIndex) {
      return true;
    }
    const [track] = this.queue.splice(fromIndex, 1);
    this.queue.splice(toIndex, 0, track);
    this.eventEmitter.emit('queueChanged', { action: 'move', fromIndex, toIndex, queueLength: this.queue.length });
    return true;
  }

  /**
   * Swap two tracks in the queue
   */
  public swapTracks(indexA: number, indexB: number): boolean {
    if (
      indexA < 0 ||
      indexB < 0 ||
      indexA >= this.queue.length ||
      indexB >= this.queue.length
    ) {
      return false;
    }
    if (indexA === indexB) {
      return true;
    }
    [this.queue[indexA], this.queue[indexB]] = [this.queue[indexB], this.queue[indexA]];
    this.eventEmitter.emit('queueChanged', { action: 'swap', indexA, indexB, queueLength: this.queue.length });
    return true;
  }

  /**
   * Remove a track from the queue by index
   */
  public removeTrack(index: number): Track | undefined {
    if (index < 0 || index >= this.queue.length) {
      return undefined;
    }
    const removed = this.queue.splice(index, 1)[0];
    this.eventEmitter.emit('queueChanged', { action: 'remove', index, queueLength: this.queue.length });
    return removed;
  }

  /**
   * Jump to a specific track in the queue and start playing it
   */
  public async jumpTo(index: number): Promise<boolean> {
    if (index < 0 || index >= this.queue.length) {
      return false;
    }
    const [nextTrack] = this.queue.splice(index, 1);

    // Keep current track in history if it exists
    if (this.track) {
      this.previousTracks.push(this.track);
    }

    await this.play(nextTrack);
    return true;
  }

  /**
   * Clear the queue
   */
  public clearQueue(): void {
    this.queue = [];
    this.eventEmitter.emit('queueChanged', { action: 'clear', queueLength: 0 });
  }

  /**
   * Get a summary of the queue
   */
  public getQueueInfo(): {
    length: number;
    totalDurationMs: number;
    nowPlaying: Track | null;
    upcomingSample: Track[];
  } {
    const totalDurationMs = this.queue.reduce((sum, t) => sum + (t.info.length || 0), 0);
    const upcomingSample = this.queue.slice(0, Math.min(5, this.queue.length));

    return {
      length: this.queue.length,
      totalDurationMs,
      nowPlaying: this.track,
      upcomingSample,
    };
  }

  /**
   * Get the next N tracks without mutating the queue
   */
  public getUpcoming(count: number = 5): Track[] {
    if (count <= 0) {
      return [];
    }
    return this.queue.slice(0, count);
  }

  /**
   * Set loop mode
   */
  public setLoopMode(mode: 'off' | 'track' | 'queue'): void {
    this.loopMode = mode;
    this.eventEmitter.emit('debug', `Loop mode set to: ${mode}`);
  }

  /**
   * Set crossfade duration
   */
  public setCrossfade(duration: number): void {
    this.crossfadeDuration = Math.max(0, duration);
    this.eventEmitter.emit('debug', `Crossfade duration set to: ${duration}ms`);
  }

  /**
   * Enable/disable volume normalization
   */
  public setVolumeNormalization(enabled: boolean): void {
    this.volumeNormalization = enabled;
    this.eventEmitter.emit('debug', `Volume normalization ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Set playback speed (independent of pitch)
   */
  public async setSpeed(speed: number): Promise<void> {
    if (speed < 0.25 || speed > 3.0) {
      throw new Error('Speed must be between 0.25 and 3.0');
    }
    const nextFilters: FilterOptions = {
      ...this.currentFilters,
      timescale: {
        speed,
        pitch: this.currentFilters.timescale?.pitch ?? 1.0,
        rate: this.currentFilters.timescale?.rate ?? 1.0,
      },
    };
    await this.setFilters(nextFilters);
    this.eventEmitter.emit('debug', `Speed set to: ${speed}x`);
  }

  /**
   * Set playback pitch (independent of speed)
   */
  public async setPitch(pitch: number): Promise<void> {
    if (pitch < 0.25 || pitch > 3.0) {
      throw new Error('Pitch must be between 0.25 and 3.0');
    }
    const nextFilters: FilterOptions = {
      ...this.currentFilters,
      timescale: {
        speed: this.currentFilters.timescale?.speed ?? 1.0,
        pitch,
        rate: this.currentFilters.timescale?.rate ?? 1.0,
      },
    };
    await this.setFilters(nextFilters);
    this.eventEmitter.emit('debug', `Pitch set to: ${pitch}x`);
  }

  /**
   * Set both speed and pitch
   */
  public async setSpeedAndPitch(speed: number, pitch: number): Promise<void> {
    if (speed < 0.25 || speed > 3.0 || pitch < 0.25 || pitch > 3.0) {
      throw new Error('Speed and pitch must be between 0.25 and 3.0');
    }
    const nextFilters: FilterOptions = {
      ...this.currentFilters,
      timescale: {
        speed,
        pitch,
        rate: this.currentFilters.timescale?.rate ?? 1.0,
      },
    };
    await this.setFilters(nextFilters);
    this.eventEmitter.emit('debug', `Speed set to: ${speed}x, Pitch set to: ${pitch}x`);
  }

  /**
   * Save queue to JSON for persistence
   */
  public saveQueue(): string {
    return JSON.stringify({
      queue: this.queue,
      currentTrack: this.track,
      position: this.position,
      volume: this.volume,
      loopMode: this.loopMode,
      paused: this.paused,
    });
  }

  /**
   * Restore queue from JSON
   */
  public async restoreQueue(data: string): Promise<void> {
    try {
      const saved = JSON.parse(data);
      this.queue = saved.queue || [];
      this.loopMode = saved.loopMode || 'off';
      
      if (saved.volume !== undefined) {
        await this.setVolume(saved.volume);
      }
      
      if (saved.currentTrack) {
        await this.play(saved.currentTrack, { startTime: saved.position || 0 });
        if (saved.paused) {
          await this.pause();
        }
      }
      
      this.eventEmitter.emit('debug', 'Queue restored from save');
    } catch (error) {
      throw new Error(`Failed to restore queue: ${error}`);
    }
  }

  /**
   * Shuffle the queue
   */
  public shuffleQueue(): void {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.eventEmitter.emit('queueChanged', { action: 'shuffle', queueLength: this.queue.length });
  }

  /**
   * Skip to the next track in the queue
   */
  public async skip(): Promise<boolean> {
    if (this.queue.length === 0) {
      await this.stop();
      return false;
    }

    // Track that a track was skipped
    if (this.track) {
      this.skippedTracks++;
    }

    await this.play();
    return true;
  }

  /**
   * Play the previous track
   */
  public async previous(): Promise<boolean> {
    if (this.previousTracks.length === 0) {
      return false;
    }

    const previousTrack = this.previousTracks.pop()!;
    if (this.track) {
      this.queue.unshift(this.track);
    }
    await this.play(previousTrack);
    return true;
  }

  // ==================== Search & Load ====================

  /**
   * Search for tracks with smart rate limiting
   * Only applies rate limiting to actual search queries (not direct URLs/tracks)
   */
  public async search(
    query: string,
    platform?: SearchPlatformType
  ): Promise<LoadResult> {
    if (!this.node.isConnected()) {
      this.eventEmitter.emit('debug', `⚠ Cannot search: Node ${this.node.options.name} is not connected`);
      throw new Error(`Node ${this.node.options.name} is not connected`);
    }

    // If query is a URL or encoded track, skip rate limiting (direct operations)
    const isUrl = /^https?:\/\//.test(query);
    const isEncodedTrack = query.startsWith('dQw4w9WgXcQ'); // Base64-ish pattern for encoded tracks
    
    if (!isUrl && !isEncodedTrack) {
      // Apply rate limiting only to search queries
      const now = Date.now();
      const timeSinceLastSearch = now - this.lastSearchTime;
      if (timeSinceLastSearch < this.apiRateLimitDelay) {
        await new Promise(resolve => setTimeout(resolve, this.apiRateLimitDelay - timeSinceLastSearch));
      }
      this.lastSearchTime = Date.now();
    }
    
    const searchPlatform = platform ?? this.defaultSearchPlatform;
    const identifier = isUrl ? query : `${searchPlatform}:${query}`;
    this.eventEmitter.emit('debug', `Searching: ${identifier}`);
    
    try {
      return await this.node.loadTracks(identifier);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.eventEmitter.emit('debug', `✗ Search failed: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Load tracks from a URL or search query
   */
  public async load(identifier: string): Promise<LoadResult> {
    if (!this.node.isConnected()) {
      this.eventEmitter.emit('debug', `⚠ Cannot load tracks: Node ${this.node.options.name} is not connected`);
      throw new Error(`Node ${this.node.options.name} is not connected`);
    }
    
    try {
      return await this.node.loadTracks(identifier);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.eventEmitter.emit('debug', `✗ Load failed: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Load multiple identifiers in parallel (useful for batch playlist loading)
   * Much faster than loading sequentially
   */
  public async loadBatch(identifiers: string[]): Promise<LoadResult[]> {
    if (!this.node.isConnected()) {
      this.eventEmitter.emit('debug', `⚠ Cannot load batch: Node ${this.node.options.name} is not connected`);
      throw new Error(`Node ${this.node.options.name} is not connected`);
    }

    if (identifiers.length === 0) {
      return [];
    }

    this.eventEmitter.emit('debug', `Loading ${identifiers.length} tracks in parallel...`);
    
    try {
      // Load all identifiers in parallel for maximum speed
      const results = await Promise.all(
        identifiers.map(id => this.node.loadTracks(id))
      );
      
      // Auto-add all successful tracks to queue
      let addedCount = 0;
      for (const result of results) {
        if (result.loadType === 'track' && result.data) {
          if (this.addTrack(result.data)) {
            addedCount++;
          }
        } else if (result.loadType === 'search' && result.data) {
          addedCount += this.addTracks(result.data);
        } else if (result.loadType === 'playlist' && result.data) {
          addedCount += this.addTracks(result.data.tracks);
        }
      }
      
      this.eventEmitter.emit('debug', `✓ Batch load complete: added ${addedCount} tracks`);
      return results;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.eventEmitter.emit('debug', `✗ Batch load failed: ${errorMessage}`);
      throw error;
    }
  }

  // ==================== Voice State Management ====================

  /**
   * Update voice state (called by VoiceForwarder)
   */
  public async updateVoiceState(state: Partial<VoiceState>): Promise<void> {
    this.voiceState = { ...this.voiceState, ...state };

    // If we have complete voice state, update the player
    if (
      this.voiceState.token &&
      this.voiceState.endpoint &&
      this.voiceState.sessionId
    ) {
      if (!this.node.isConnected()) {
        this.eventEmitter.emit('debug', `⚠ Cannot update voice state: Node ${this.node.options.name} is not connected`);
        // Store the voice state anyway so it can be sent when node reconnects
        return;
      }

      try {
        const channelId = this.voiceState.channelId ?? this.voiceChannelId;

        await this.node.updatePlayer(this.guildId, {
          voice: {
            ...(this.voiceState as VoiceState),
            channelId,
          },
        });
        this.connected = true;
        this.eventEmitter.emit('debug', `Voice state updated for guild ${this.guildId}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.eventEmitter.emit('debug', `✗ Error updating voice state: ${errorMessage}`);
        throw error;
      }
    }
  }

  // ==================== State Management ====================

  /**
   * Update player state from PlayerUpdateEvent
   */
  public updateState(state: PlayerState): void {
    this.position = state.position;
    this.connected = state.connected;
    this.ping = state.ping;
  }

  /**
   * Get current player state
   */
  public getState(): PlayerState {
    return {
      volume: this.volume,
      paused: this.paused,
      position: this.position,
      connected: this.connected,
      ping: this.ping,
    };
  }

  /**
   * Check if player is playing
   */
  public isPlaying(): boolean {
    return this.track !== null && !this.paused;
  }

  /**
   * Get total queue duration
   */
  public getQueueDuration(): number {
    return this.queue.reduce((total, track) => total + track.info.length, 0);
  }

  /**
   * Get currently applied filter state
   */
  public getCurrentFilters(): FilterOptions {
    return { ...this.currentFilters };
  }

  /**
   * Migrate this player to a different node and optionally resume playback state
   */
  public async migrateToNode(newNode: Node, options?: { resumePlayback?: boolean }): Promise<void> {
    if (this.node.options.name === newNode.options.name) {
      return;
    }

    if (!newNode.isConnected()) {
      throw new Error(`Target node ${newNode.options.name} is not connected`);
    }

    const previousNode = this.node;
    const resumePlayback = options?.resumePlayback ?? true;
    const currentTrack = this.track;
    const currentPosition = this.position;
    const currentPaused = this.paused;
    const currentVolume = this.volume;
    const filters = this.getCurrentFilters();

    this.node = newNode;

    if (
      this.voiceState.token &&
      this.voiceState.endpoint &&
      this.voiceState.sessionId
    ) {
      await this.updateVoiceState(this.voiceState);
    }

    await this.setVolume(currentVolume);

    if (Object.keys(filters).length > 0) {
      await this.setFilters(filters);
    }

    if (resumePlayback && currentTrack) {
      await this.play(currentTrack, {
        startTime: Math.max(0, currentPosition),
        noReplace: false,
      });

      if (currentPaused) {
        await this.pause(true);
      }
    }

    this.eventEmitter.emit(
      'debug',
      `Player node migrated for guild ${this.guildId}: ${previousNode.options.name} -> ${newNode.options.name}`
    );
  }

  // ==================== Internal Methods ====================

  /**
   * Start position update interval
   */
  private startPositionUpdate(): void {
    this.clearPositionUpdate();
    this.positionUpdateInterval = setInterval(() => {
      if (this.isPlaying() && this.track) {
        this.position += 1000;
        // Clamp position to track length
        if (this.position > this.track.info.length) {
          this.position = this.track.info.length;
        }
      }
    }, 1000);
  }

  /**
   * Clear position update interval
   */
  private clearPositionUpdate(): void {
    if (this.positionUpdateInterval) {
      clearInterval(this.positionUpdateInterval);
      this.positionUpdateInterval = null;
    }
  }

  /**
   * Handle track end (called by Manager)
   */
  public async handleTrackEnd(track: Track | null, reason: string): Promise<void> {
    const endedTrack = track ?? this.track;
    const normalizedReason = reason.replace(/[_\s]/g, '').toLowerCase();
    const isFinished = normalizedReason === 'finished';

    if (!endedTrack) {
      this.eventEmitter.emit('debug', `Track end received with no track reference (reason=${reason})`);
      return;
    }

    const isCurrentTrack = this.track?.encoded === endedTrack.encoded;

    // Add to history and previous lists based on the track that actually ended
    this.history.push(endedTrack);
    if (this.history.length > this.historyMaxSize) {
      this.history.shift();
    }

    this.previousTracks.push(endedTrack);
    // Keep only last 10 previous tracks
    if (this.previousTracks.length > 10) {
      this.previousTracks.shift();
    }

    // Debug logging
    this.eventEmitter.emit(
      'debug',
      `Track ended: title=${endedTrack.info.title}, reason=${reason}, normalizedReason=${normalizedReason}, loopMode=${this.loopMode}, autoPlay=${this.autoPlay}, queueLength=${this.queue.length}`
    );

    // If this end event corresponds to the currently tracked song, clear local state
    if (isCurrentTrack) {
      this.track = null;
      this.position = 0;
      this.clearPositionUpdate();
    }

    // Handle loop modes
    if (isFinished && this.loopMode === 'track') {
      this.eventEmitter.emit('debug', 'Looping current track');
      // Track that this track is being repeated
      this.repeatTracks.add(endedTrack.encoded);
      try {
        await this.play(endedTrack);
      } catch (error) {
        this.eventEmitter.emit('debug', `Error looping track: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      return;
    }

    if (isFinished && this.loopMode === 'queue') {
      // Add ended track back to end of queue
      this.queue.push(endedTrack);
    }

    // Auto-play next track from queue if available
    if (isFinished && this.queue.length > 0) {
      this.eventEmitter.emit('debug', 'Playing next track from queue');
      try {
        await this.play();
      } catch (error) {
        this.eventEmitter.emit('debug', `Error playing next track: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      return;
    }

    // If queue is empty and autoPlay is enabled, try to find related tracks
    if (this.autoPlay && isFinished && this.queue.length === 0) {
      this.eventEmitter.emit('debug', 'Queue empty, attempting AutoPlay...');
      try {
        const success = await this.autoPlayEngine.execute(this, endedTrack);
        if (success) {
          this.eventEmitter.emit('debug', 'AutoPlay succeeded, continuing playback');
          return; // AutoPlay added a track and started playing
        }
        this.eventEmitter.emit('debug', 'AutoPlay failed to find related tracks');
      } catch (error) {
        this.eventEmitter.emit('debug', `AutoPlay error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Only emit queueEnd if queue is still empty after AutoPlay attempt and no current track
    if (this.queue.length === 0 && !this.track) {
      this.eventEmitter.emit('debug', 'Queue is empty, emitting queueEnd');
      this.eventEmitter.emit('queueEnd', this);
    }
  }
}
