/**
 * AutoPlay - Intelligent track recommendations based on previous track
 * Fetches related tracks from YouTube, SoundCloud, or Spotify when queue ends
 */

import type { Player } from '../player/Player';
import type { Track } from '../types/lavalink';

export class AutoPlay {
  private playedIdentifiers: Set<string> = new Set();
  private maxHistorySize: number = 50;

  private extractTracks(result: Awaited<ReturnType<Player['search']>>): Track[] {
    if (result.loadType === 'playlist') {
      return result.data.tracks;
    }

    if (result.loadType === 'search') {
      return result.data;
    }

    if (result.loadType === 'track') {
      return [result.data];
    }

    return [];
  }

  private isTrackUsable(track: Track, previousTrack: Track): boolean {
    const title = track.info.title?.trim() ?? '';
    if (!title || title.length < 2) {
      return false;
    }

    // Prevent obvious garbage results such as "1", "2", etc.
    if (/^\d{1,3}$/.test(title)) {
      return false;
    }

    const prevId = previousTrack.info.identifier || previousTrack.info.uri;
    const currentId = track.info.identifier || track.info.uri;
    if (prevId && currentId && prevId === currentId) {
      return false;
    }

    return true;
  }

  private pickCandidate(tracks: Track[], previousTrack: Track): Track | null {
    const usable = tracks.filter((track) => this.isTrackUsable(track, previousTrack));

    let available = usable.filter((track) => {
      const trackId = track.info.identifier || track.info.uri;
      return trackId && !this.playedIdentifiers.has(trackId);
    });

    if (!available.length) {
      available = usable;
    }

    if (!available.length) {
      return null;
    }

    return available[Math.floor(Math.random() * available.length)] ?? null;
  }

  private async enqueueAndPlay(player: Player, track: Track, sourceLabel: string): Promise<boolean> {
    const added = player.addTrack(track);
    if (!added) {
      player.eventEmitter.emit('debug', '[AutoPlay] Queue is full, unable to add track');
      return false;
    }

    player.eventEmitter.emit('debug', `[AutoPlay] Track added to queue: ${track.info.title}, queue size: ${player.queue.length}`);

    try {
      await player.play();
    } catch (error) {
      player.eventEmitter.emit('debug', `[AutoPlay] Error playing track: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }

    player.eventEmitter.emit('debug', `[AutoPlay] Added ${sourceLabel} track: ${track.info.title}`);
    return true;
  }

  /**
   * Attempt to find and play a related track based on the previous track
   */
  public async execute(player: Player, previousTrack: Track): Promise<boolean> {
    if (!previousTrack) {
      player.eventEmitter.emit('debug', '[AutoPlay] No previous track provided');
      return false;
    }

    // Check if node is connected
    if (!player.node.isConnected()) {
      player.eventEmitter.emit('debug', '[AutoPlay] Node not connected, aborting');
      return false;
    }

    const sourceName = previousTrack.info.sourceName;
    const identifier = previousTrack.info.identifier || previousTrack.info.uri;

    // Add to played history
    if (identifier) {
      this.playedIdentifiers.add(identifier);
      if (this.playedIdentifiers.size > this.maxHistorySize) {
        const firstItem = this.playedIdentifiers.values().next().value;
        if (firstItem) {
          this.playedIdentifiers.delete(firstItem);
        }
      }
    }

    player.eventEmitter.emit('debug', `[AutoPlay] Initiated for ${sourceName}: ${previousTrack.info.title}`);

    try {
      switch (sourceName) {
        case 'youtube':
          return await this.handleYouTube(player, previousTrack);
        case 'soundcloud':
          return await this.handleSoundCloud(player, previousTrack);
        case 'spotify':
          return await this.handleSpotify(player, previousTrack);
        default:
          return await this.handleYouTube(player, previousTrack); // Fallback to YouTube
      }
    } catch (error) {
      player.eventEmitter.emit('debug', `[AutoPlay] Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  /**
   * YouTube AutoPlay - Uses YouTube's RD (Radio/Recommendations) playlist
   */
  private async handleYouTube(player: Player, previousTrack: Track): Promise<boolean> {
    const identifier = previousTrack.info.identifier;
    if (!identifier) {
      player.eventEmitter.emit('debug', '[AutoPlay] No identifier found for YouTube track');
      return false;
    }

    // YouTube's RD playlist URL for recommendations
    const rdUrl = `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`;
    player.eventEmitter.emit('debug', `[AutoPlay] Searching YouTube RD: ${rdUrl}`);
    
    const result = await player.search(rdUrl, 'ytsearch');
    player.eventEmitter.emit('debug', `[AutoPlay] Search result type: ${result.loadType}`);

    if (result.loadType === 'error' || result.loadType === 'empty') {
      player.eventEmitter.emit('debug', `[AutoPlay] YouTube search failed: ${result.loadType}`);
      return false;
    }

    const tracks = this.extractTracks(result);

    player.eventEmitter.emit('debug', `[AutoPlay] Found ${tracks.length} tracks`);

    const randomTrack = this.pickCandidate(tracks, previousTrack);
    if (!randomTrack) {
      player.eventEmitter.emit('debug', '[AutoPlay] No usable YouTube track candidates');
      return false;
    }

    return this.enqueueAndPlay(player, randomTrack, 'YouTube');
  }

  /**
   * SoundCloud AutoPlay - Uses SoundCloud's related tracks
   */
  private async handleSoundCloud(player: Player, previousTrack: Track): Promise<boolean> {
    const uri = previousTrack.info.uri;
    if (!uri) return false;

    // Search for related SoundCloud tracks
    const query = `${previousTrack.info.title} ${previousTrack.info.author}`;
    const result = await player.search(query, 'scsearch');

    if (result.loadType === 'error' || result.loadType === 'empty') {
      return false;
    }

    const tracks = this.extractTracks(result);
    const randomTrack = this.pickCandidate(tracks, previousTrack);
    if (!randomTrack) {
      player.eventEmitter.emit('debug', '[AutoPlay] No usable SoundCloud track candidates');
      return false;
    }

    return this.enqueueAndPlay(player, randomTrack, 'SoundCloud');
  }

  /**
   * Spotify AutoPlay - Use Spotify recommendations API
   */
  private async handleSpotify(player: Player, previousTrack: Track): Promise<boolean> {
    const identifier = previousTrack.info.identifier;
    const title = previousTrack.info.title;
    const author = previousTrack.info.author;

    if (!identifier) {
      player.eventEmitter.emit('debug', '[AutoPlay] Missing identifier for Spotify track');
      return false;
    }

    const attempts: Array<{ label: string; query: string; platform: 'spsearch' | 'ytmsearch' | 'ytsearch' }> = [];

    // If backend supports Spotify recommendations, this often yields the best result.
    attempts.push({ label: 'Spotify recommendations', query: `sprec:${identifier}`, platform: 'spsearch' });

    // Search by title + author is generally more reliable than raw spotify ID.
    if (title && author) {
      attempts.push({ label: 'Spotify title+artist search', query: `${title} ${author}`, platform: 'spsearch' });
      attempts.push({ label: 'YouTube Music title+artist search', query: `${title} ${author}`, platform: 'ytmsearch' });
      attempts.push({ label: 'YouTube title+artist search', query: `${title} ${author}`, platform: 'ytsearch' });
    }

    for (const attempt of attempts) {
      player.eventEmitter.emit('debug', `[AutoPlay] ${attempt.label}: ${attempt.query}`);

      const recResult = await player.search(attempt.query, attempt.platform);
      if (recResult.loadType === 'error' || recResult.loadType === 'empty') {
        continue;
      }

      const tracks = this.extractTracks(recResult);
      const selected = this.pickCandidate(tracks, previousTrack);
      if (!selected) {
        continue;
      }

      return this.enqueueAndPlay(player, selected, 'Spotify recommended');
    }

    player.eventEmitter.emit('debug', '[AutoPlay] No usable Spotify recommendations, falling back to artist search');
    return this.handleSpotifyArtistFallback(player, previousTrack);
  }

  /**
   * Fallback: Search for artist tracks when recommendations fail
   */
  private async handleSpotifyArtistFallback(player: Player, previousTrack: Track): Promise<boolean> {
    const artist = previousTrack.info.author;

    if (!artist) {
      return false;
    }

    const artistResult = await player.search(`${artist}`, 'spsearch');

    if (artistResult.loadType === 'empty' || artistResult.loadType === 'error') {
      return false;
    }

    const artistTracks = this.extractTracks(artistResult);

    if (!artistTracks.length) {
      return false;
    }

    const randomTrack = this.pickCandidate(artistTracks, previousTrack);
    if (!randomTrack) {
      player.eventEmitter.emit('debug', '[AutoPlay] No usable artist fallback candidates');
      return false;
    }

    return this.enqueueAndPlay(player, randomTrack, 'Spotify artist fallback');
  }

  /**
   * Clear played history
   */
  public clearHistory(): void {
    this.playedIdentifiers.clear();
  }

  /**
   * Get played history size
   */
  public getHistorySize(): number {
    return this.playedIdentifiers.size;
  }
}
