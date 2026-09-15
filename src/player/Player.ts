import { Queue } from './Queue';
import { Filters } from './Filters';
import type { Raya } from '../Raya';
import type { Node } from '../node/Node';
import type {
  CoreEvent,
  DiscordVoiceStateUpdatePayload,
  GatewayVoiceServerUpdate,
  GatewayVoiceState,
  LavalinkPlayer,
  LavalinkPlayerState,
  LavalinkTrack,
  Lyrics,
  TrackEndReason,
  UpdatePlayerPayload,
  VoiceState,
} from '../types/lavalink';
import type {
  CreatePlayerOptions,
  LoopMode,
  PlayOptions,
  PlayerDestroyReason,
  PlayerSnapshot,
  ResolvedPlayerDefaults,
  SearchOptions,
  SearchResult,
  Track,
} from '../types/raya';
import { RayaError } from '../utils/errors';
import { decodeTrack } from '../utils/TrackCodec';
import { isSameTrack } from '../utils/tracks';
import { sleep } from '../utils/backoff';

interface Batch {
  payload: UpdatePlayerPayload;
  waiters: Array<{ resolve: (player: LavalinkPlayer) => void; reject: (error: unknown) => void }>;
}

interface VoiceWaiter {
  channelId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type AdvanceReason = 'finished' | 'loadFailed' | 'skip';

/** Autoplay stops after this many consecutive load failures to avoid failure loops. */
const MAX_AUTOPLAY_FAILURES = 3;
const LOOP_MODES: readonly LoopMode[] = ['off', 'track', 'queue'];

const voiceKey = (v: Partial<VoiceState>) => `${v.sessionId}|${v.token}|${v.endpoint}|${v.channelId ?? ''}`;

/**
 * A guild's music player.
 */
export class Player {
  public readonly raya: Raya;
  public readonly guildId: string;
  public readonly queue: Queue;
  public readonly filters: Filters;
  /** Free-form per-player storage, included in snapshots */
  public readonly data = new Map<string, unknown>();
  public readonly createdAt = Date.now();

  public node: Node;
  public voiceChannelId: string | null;
  public textChannelId: string | null;
  public current: Track | null = null;
  public paused = false;
  /** 0 - 1000, where 100 is unchanged */
  public volume: number;
  public loop: LoopMode;
  public autoplay: boolean;
  public selfDeaf: boolean;
  public selfMute: boolean;
  /** Whether Lavalink is connected to the Discord voice server */
  public connected = false;
  /** Lavalink to Discord voice ping in ms, -1 when unknown */
  public ping = -1;
  public destroyed = false;

  /** @internal */ public _orphaned = false;
  /** @internal */ public _voiceStale = false;
  /** @internal */ public _hasRemoteState = false;

  private readonly defaults: ResolvedPlayerDefaults;
  private voice: Partial<VoiceState> = {};
  private forwardedVoiceKey: string | null = null;
  private voiceWaiters: VoiceWaiter[] = [];
  private anchorPosition = 0;
  private anchorTime = Date.now();
  private frozen = false;
  private openBatch: Batch | null = null;
  private sendChain: Promise<void>;
  /** Cleanup of the previous player in this guild, if it is still being destroyed */
  private predecessor: Promise<void> | null;
  private replaced: Track | null = null;
  private transitioning: Track | null = null;
  private readonly announced = new WeakSet<Track>();
  private advanceToken = 0;
  private failures = 0;
  private queueEndTimer: NodeJS.Timeout | null = null;
  private emptyTimer: NodeJS.Timeout | null = null;
  private voiceRecoveryTimer: NodeJS.Timeout | null = null;
  private emptySince: number | null = null;
  private pausedByEmpty = false;
  private leaving = false;
  private rejoining = false;
  private moving: Promise<void> | null = null;

  /** Use `raya.createPlayer()` or `raya.join()` instead of constructing players directly. */
  constructor(raya: Raya, node: Node, options: CreatePlayerOptions, defaults: ResolvedPlayerDefaults, after?: Promise<void>) {
    this.raya = raya;
    this.node = node;
    this.defaults = defaults;
    this.guildId = options.guildId;
    this.voiceChannelId = options.voiceChannelId;
    this.textChannelId = options.textChannelId ?? null;
    this.volume = clampVolume(options.volume ?? defaults.volume);
    this.loop = options.loop ?? defaults.loop;
    this.autoplay = options.autoplay ?? defaults.autoplay;
    this.selfDeaf = options.selfDeaf ?? defaults.selfDeaf;
    this.selfMute = options.selfMute ?? defaults.selfMute;
    this.queue = new Queue(this, defaults.maxQueueSize, defaults.historySize);
    this.filters = new Filters(this);
    this.predecessor = after ?? null;
    this.sendChain = after ?? Promise.resolve();
    after?.then(() => {
      this.predecessor = null;
    });
  }

  // ==================== State ====================

  /** Current position in ms, interpolated locally between Lavalink updates. */
  public get position(): number {
    const track = this.current;
    if (!track) return 0;
    let position = this.anchorPosition;
    if (!this.paused && !this.frozen) position += (Date.now() - this.anchorTime) * this.filters.speedMultiplier;
    if (!track.info.isStream) position = Math.min(position, track.info.length);
    return Math.max(0, Math.floor(position));
  }

  /** A track is loaded and not paused */
  public get playing(): boolean {
    return this.current !== null && !this.paused;
  }

  /** Nothing is loaded */
  public get idle(): boolean {
    return this.current === null;
  }

  /** Voice credentials currently known for this player */
  public get voiceState(): Readonly<Partial<VoiceState>> {
    return this.voice;
  }

  // ==================== Voice ====================

  /**
   * Join (or move to) a voice channel and wait until Lavalink has the voice credentials.
   */
  public async connect(options: { channelId?: string; timeout?: number } = {}): Promise<void> {
    this.assertAlive();
    const channelId = options.channelId ?? this.voiceChannelId;
    if (!channelId) throw new RayaError('INVALID_ARGUMENT', 'connect() needs a voice channel id');
    if (!this._voiceStale && this.forwardedVoiceKey && this.voice.channelId === channelId) return;
    if (this._voiceStale) {
      this.voice = {};
      this.forwardedVoiceKey = null;
    }

    const timeout = options.timeout ?? this.defaults.voiceTimeout;
    const waiting = new Promise<void>((resolve, reject) => {
      const waiter: VoiceWaiter = {
        channelId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.voiceWaiters = this.voiceWaiters.filter((w) => w !== waiter);
          reject(new RayaError('VOICE_TIMEOUT', `Timed out after ${timeout}ms waiting for voice in guild ${this.guildId}. Check that raw gateway events reach raya.handleRaw().`));
        }, timeout),
      };
      waiter.timer.unref();
      this.voiceWaiters.push(waiter);
    });
    waiting.catch(() => undefined);

    try {
      await this.sendVoiceUpdate(channelId);
    } catch (error) {
      this.rejectVoiceWaiters(error as Error, channelId);
      throw error;
    }
    return waiting;
  }

  /** Move the bot to another voice channel. */
  public moveTo(channelId: string, timeout?: number): Promise<void> {
    return this.connect({ channelId, timeout });
  }

  /** Leave the voice channel but keep the player (queue, filters, ...). */
  public async disconnect(): Promise<void> {
    this.assertAlive();
    this.leaving = true;
    try {
      await this.sendVoiceUpdate(null);
    } finally {
      this.voice = {};
      this.forwardedVoiceKey = null;
      this.connected = false;
      this.voiceChannelId = null;
      setTimeout(() => {
        this.leaving = false;
      }, 1000).unref();
    }
  }

  public setSelfDeaf(deaf: boolean): Promise<void> {
    this.selfDeaf = deaf;
    return this.voiceChannelId ? this.sendVoiceUpdate(this.voiceChannelId) : Promise.resolve();
  }

  public setSelfMute(mute: boolean): Promise<void> {
    this.selfMute = mute;
    return this.voiceChannelId ? this.sendVoiceUpdate(this.voiceChannelId) : Promise.resolve();
  }

  private async sendVoiceUpdate(channelId: string | null): Promise<void> {
    // A replacement player must not join before the previous player in this guild has left.
    if (this.predecessor) await this.predecessor;
    const payload: DiscordVoiceStateUpdatePayload = {
      op: 4,
      d: { guild_id: this.guildId, channel_id: channelId, self_mute: this.selfMute, self_deaf: this.selfDeaf },
    };
    return this.raya._sendGateway(this.guildId, payload);
  }

  // ==================== Playback ====================

  /**
   * Play a track, an encoded track string, or (with no argument) the next queued track.
   */
  public async play(input?: Track | string | null, options: PlayOptions = {}): Promise<void> {
    this.assertAlive();
    if (options.noReplace && this.current) return;
    let track: Track | undefined;
    if (input === undefined || input === null) {
      track = this.queue.shift();
      if (!track) throw new RayaError('NO_TRACK', 'Nothing to play: the queue is empty');
    } else if (typeof input === 'string') {
      track = { ...decodeTrack(input) };
      if (options.requester !== undefined) track.requester = this.raya._transformRequester(options.requester);
    } else {
      if (typeof input.encoded !== 'string') throw new RayaError('INVALID_ARGUMENT', 'play() expects a Lavalink track');
      track = input;
    }
    this.failures = 0;
    this.advanceToken++;
    await this.start(track, options);
  }

  /**
   * Add a search result, a track or tracks to the queue and start playback when idle.
   * Search results add their first track, playlists add every track.
   */
  public async enqueue(
    input: SearchResult | Track | readonly Track[],
    options: { index?: number } = {},
  ): Promise<{ added: Track[]; started: boolean }> {
    this.assertAlive();
    let tracks: Track[];
    if (Array.isArray(input)) tracks = [...(input as Track[])];
    else if ('encoded' in (input as Track)) tracks = [input as Track];
    else {
      const result = input as SearchResult;
      tracks = result.type === 'playlist' ? result.tracks : result.tracks.slice(0, 1);
    }
    if (tracks.length === 0) return { added: [], started: false };

    const count = this.queue.add(tracks, options.index);
    const added = tracks.slice(0, count);
    let started = false;
    if (!this.current && !this.queue.isEmpty) {
      await this.play();
      started = true;
    }
    return { added, started };
  }

  /** Skip the current track (or `amount` tracks). Resolves with the new current track. */
  public async skip(amount = 1): Promise<Track | null> {
    this.assertAlive();
    if (!Number.isInteger(amount) || amount < 1) throw new RayaError('INVALID_ARGUMENT', 'skip amount must be a positive integer');
    if (amount > 1) this.queue.removeRange(0, amount - 1);
    this.failures = 0;
    await this.advance(this.current, 'skip');
    return this.current;
  }

  /** Play the previously played track, putting the current one back at the front of the queue. */
  public async previous(): Promise<Track | null> {
    this.assertAlive();
    const track = this.queue._popHistory();
    if (!track) return null;
    const current = this.current;
    try {
      this.advanceToken++;
      await this.start(track, { addToHistory: false });
    } catch (error) {
      this.queue._pushHistory(track);
      throw error;
    }
    if (current) this.queue._restore([current, ...this.queue.toArray()], [...this.queue.history]);
    this.raya.emit('queueUpdate', this, this.queue);
    return track;
  }

  /** Stop playback. The queue is kept unless `clearQueue` is set. */
  public async stop(options: { clearQueue?: boolean } = {}): Promise<void> {
    this.assertAlive();
    if (options.clearQueue) this.queue.clear();
    const previous = this.current;
    if (previous) this.queue._pushHistory(previous);
    this.advanceToken++;
    this.replaced = previous;
    this.current = null;
    this.anchorPosition = 0;
    await this._update({ track: { encoded: null } });
  }

  public async pause(pause = true): Promise<void> {
    this.assertAlive();
    this.pausedByEmpty = false;
    await this.setPaused(pause);
  }

  public resume(): Promise<void> {
    return this.pause(false);
  }

  /** Seek to a position in ms (clamped to the track length). */
  public async seek(position: number): Promise<void> {
    this.assertAlive();
    const track = this.current;
    if (!track) throw new RayaError('NO_TRACK', 'Nothing is playing');
    if (!track.info.isSeekable) throw new RayaError('INVALID_ARGUMENT', 'This track is not seekable');
    if (!Number.isFinite(position)) throw new RayaError('INVALID_ARGUMENT', 'Position must be a number');
    const target = Math.floor(Math.max(0, Math.min(position, track.info.length)));
    this.anchorPosition = target;
    this.anchorTime = Date.now();
    await this._update({ position: target });
  }

  /** Restart the current track. */
  public replay(): Promise<void> {
    return this.seek(0);
  }

  /** Volume from 0 to 1000, where 100 is the original loudness. */
  public async setVolume(volume: number): Promise<void> {
    this.assertAlive();
    if (typeof volume !== 'number' || !Number.isFinite(volume)) throw new RayaError('INVALID_ARGUMENT', 'Volume must be a number');
    const previous = this.volume;
    this.volume = clampVolume(volume);
    try {
      await this._update({ volume: this.volume });
    } catch (error) {
      this.volume = previous;
      throw error;
    }
  }

  public setLoop(mode: LoopMode): this {
    if (!LOOP_MODES.includes(mode)) throw new RayaError('INVALID_ARGUMENT', `Loop mode must be one of ${LOOP_MODES.join(', ')}`);
    this.loop = mode;
    return this;
  }

  public setAutoplay(enabled: boolean): this {
    this.autoplay = enabled;
    return this;
  }

  public setTextChannel(channelId: string | null): this {
    this.textChannelId = channelId;
    return this;
  }

  /** Search on this player's node. */
  public search(query: string, options: Omit<SearchOptions, 'node'> = {}): Promise<SearchResult> {
    return this.raya.search(query, { ...options, node: this.node.connected ? this.node : undefined });
  }

  // ==================== Plugins ====================

  /** LavaLyrics: lyrics of the current track */
  public getLyrics(skipTrackSource = false): Promise<Lyrics | null> {
    return this.node.rest.getPlayerLyrics(this.guildId, skipTrackSource);
  }

  /** LavaLyrics: emit lyricsFound / lyricsLine events while playing */
  public subscribeLyrics(skipTrackSource = false): Promise<void> {
    return this.node.rest.subscribeLyrics(this.guildId, skipTrackSource);
  }

  public unsubscribeLyrics(): Promise<void> {
    return this.node.rest.unsubscribeLyrics(this.guildId);
  }

  /** SponsorBlock: segments to skip, e.g. ['sponsor', 'selfpromo', 'intro'] */
  public setSponsorBlock(categories: string[]): Promise<void> {
    return categories.length
      ? this.node.rest.setSponsorBlockCategories(this.guildId, categories)
      : this.node.rest.clearSponsorBlockCategories(this.guildId);
  }

  // ==================== Nodes ====================

  /** Move this player to another node without losing the track, position, filters or queue. */
  public async moveNode(target: Node | string): Promise<void> {
    this.assertAlive();
    const node = typeof target === 'string' ? this.raya.nodes.get(target) : target;
    if (!node) throw new RayaError('NODE_NOT_FOUND', `Node "${String(target)}" does not exist`);
    if (!node.connected) throw new RayaError('NODE_NOT_READY', `Node "${node.name}" is not ready`);
    if (node === this.node) return;
    while (this.moving) await this.moving.catch(() => undefined);
    if (node === this.node) return;

    this.moving = (async () => {
      const from = this.node;
      const position = this.position;
      await this.sendChain;
      if (from.connected && this._hasRemoteState) {
        await from.rest.destroyPlayer(this.guildId).catch(() => undefined);
      }
      from.players.delete(this);
      node.players.add(this);
      this.node = node;
      this._orphaned = false;
      this._hasRemoteState = false;
      this.anchorPosition = position;
      this.anchorTime = Date.now();
      this.frozen = true;
      await this._rebuild();
      this.raya.emit('playerNodeMove', this, from, node);
    })();
    try {
      await this.moving;
    } finally {
      this.moving = null;
    }
  }

  // ==================== Lifecycle ====================

  /** Destroy the player: stops audio, leaves voice and frees it on Lavalink. */
  public async destroy(options: { reason?: PlayerDestroyReason; disconnect?: boolean } = {}): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimers();
    this.rejectVoiceWaiters(new RayaError('PLAYER_DESTROYED', 'Player was destroyed'));
    const node = this.node;
    const cleanup = (async () => {
      const hooks = this.raya._runDestroyHooks(this);
      if (hooks) await hooks;
      if (options.disconnect !== false && this.voiceChannelId) {
        this.leaving = true;
        await this.sendVoiceUpdate(null).catch((error: Error) => this.raya.debug(() => `[Player ${this.guildId}] leave failed: ${error.message}`));
      }
      await this.sendChain;
      if (node.connected && this._hasRemoteState) {
        await node.rest.destroyPlayer(this.guildId).catch((error: Error) => this.raya.debug(() => `[Player ${this.guildId}] destroy failed: ${error.message}`));
      }
    })();
    this.raya._detachPlayer(this, cleanup);
    this.raya.debug(() => `[Player ${this.guildId}] destroyed (${options.reason ?? 'manual'})`);
    await cleanup;
    this.raya.emit('playerDestroy', this, options.reason ?? 'manual');
  }

  public toJSON(): PlayerSnapshot {
    return {
      guildId: this.guildId,
      voiceChannelId: this.voiceChannelId,
      textChannelId: this.textChannelId,
      node: this.node.name,
      selfDeaf: this.selfDeaf,
      selfMute: this.selfMute,
      volume: this.volume,
      paused: this.paused,
      loop: this.loop,
      autoplay: this.autoplay,
      track: this.current,
      position: this.position,
      filters: this.filters._payload(),
      queue: this.queue.toArray(),
      history: [...this.queue.history],
      voice: { ...this.voice },
      data: Object.fromEntries(this.data),
    };
  }

  // ==================== Internal: updates ====================

  /**
   * @internal Queue a player update. Updates made in the same tick are merged into one
   * PATCH and requests are sent strictly in order.
   */
  public _update(payload: UpdatePlayerPayload): Promise<LavalinkPlayer> {
    if (this.destroyed) return Promise.reject(new RayaError('PLAYER_DESTROYED', 'Player was destroyed'));
    return new Promise<LavalinkPlayer>((resolve, reject) => {
      let batch = this.openBatch;
      if (!batch) {
        const created: Batch = { payload: {}, waiters: [] };
        batch = created;
        this.openBatch = created;
        queueMicrotask(() => {
          if (this.openBatch === created) this.openBatch = null;
          this.sendChain = this.sendChain.then(() => this.sendBatch(created));
        });
      }
      // A new track invalidates a seek/end time queued for the previous one.
      if (payload.track !== undefined) {
        delete batch.payload.position;
        delete batch.payload.endTime;
      }
      Object.assign(batch.payload, payload);
      batch.waiters.push({ resolve, reject });
    });
  }

  private async sendBatch(batch: Batch): Promise<void> {
    try {
      if (this.destroyed) throw new RayaError('PLAYER_DESTROYED', 'Player was destroyed');
      const result = await this.node.rest.updatePlayer(this.guildId, batch.payload);
      this._hasRemoteState = true;
      for (const waiter of batch.waiters) waiter.resolve(result);
    } catch (error) {
      for (const waiter of batch.waiters) waiter.reject(error);
    }
  }

  /** @internal Resolves once queued updates have been sent. */
  public async _settle(): Promise<void> {
    await Promise.resolve();
    await this.sendChain;
  }

  private async start(track: Track, options: PlayOptions = {}): Promise<void> {
    const previous = this.current;
    const pushed = previous !== null && previous !== track && options.addToHistory !== false;
    if (pushed) this.queue._pushHistory(previous!);
    this.replaced = previous;
    this.current = track;
    this.anchorPosition = options.startTime && options.startTime > 0 ? Math.floor(options.startTime) : 0;
    this.anchorTime = Date.now();
    this.frozen = false;
    const wasPaused = this.paused;
    this.paused = options.paused ?? false;
    this.clearQueueEndTimer();

    this.raya.debug(() => `[Player ${this.guildId}] playing "${track.info.title}" (${track.info.sourceName}) on node ${this.node.name}`);

    const payload: UpdatePlayerPayload = { track: { encoded: track.encoded }, paused: this.paused };
    if (track.userData && Object.keys(track.userData).length) payload.track!.userData = track.userData;
    if (this.anchorPosition > 0) payload.position = this.anchorPosition;
    if (options.endTime !== undefined) payload.endTime = Math.floor(options.endTime);
    if (options.volume !== undefined) {
      this.volume = clampVolume(options.volume);
      payload.volume = this.volume;
    }

    try {
      await this._update(payload);
    } catch (error) {
      if (this.current === track) {
        this.current = previous;
        this.paused = wasPaused;
        if (pushed && this.queue.previous === previous) this.queue._popHistory();
      }
      throw error;
    }
  }

  private async setPaused(pause: boolean): Promise<void> {
    this.anchorPosition = this.position;
    this.anchorTime = Date.now();
    const was = this.paused;
    this.paused = pause;
    try {
      await this._update({ paused: pause });
    } catch (error) {
      this.paused = was;
      throw error;
    }
  }

  // ==================== Internal: queue flow ====================

  private async advance(ended: Track | null, reason: AdvanceReason): Promise<void> {
    if (this.destroyed) return;
    if (!ended && this.queue.isEmpty) return;
    const token = ++this.advanceToken;
    this.transitioning = ended;
    try {
      if (ended && reason === 'finished' && this.loop === 'track') {
        await this.start(ended, { addToHistory: false });
        return;
      }
      if (ended && reason !== 'loadFailed') {
        this.queue._pushHistory(ended);
        if (this.loop === 'queue') this.queue._append(ended);
      }

      const next = this.queue.shift();
      if (next) {
        await this.start(next, { addToHistory: false });
        return;
      }

      if (this.autoplay && ended && this.failures < MAX_AUTOPLAY_FAILURES) {
        const related = await this.raya._resolveAutoplay(this, ended);
        if (token !== this.advanceToken || this.destroyed) return;
        this.raya.debug(() => `[Player ${this.guildId}] autoplay ${related ? `picked "${related.info.title}"` : 'found nothing related'}`);
        if (related) {
          await this.start(related, { addToHistory: false });
          return;
        }
      }

      if (token !== this.advanceToken) return;
      this.replaced = this.current;
      this.current = null;
      this.anchorPosition = 0;
      if (reason === 'skip' && ended) await this._update({ track: { encoded: null } });
      this.raya.debug(() => `[Player ${this.guildId}] queue ended`);
      this.raya.emit('queueEnd', this, ended);
      this.startQueueEndTimer();
    } catch (error) {
      if (reason === 'skip') throw error;
      if (this.current === ended) this.current = null;
      this.emitError(error);
    } finally {
      if (token === this.advanceToken) this.transitioning = null;
    }
  }

  /** Map a track from a Lavalink event back to our own object (which carries the requester). */
  private resolveTrack(track: LavalinkTrack, preferReplaced = false): Track {
    if (preferReplaced && isSameTrack(this.replaced, track)) return this.replaced!;
    if (isSameTrack(this.current, track)) return this.current!;
    if (isSameTrack(this.transitioning, track)) return this.transitioning!;
    if (isSameTrack(this.replaced, track)) return this.replaced!;
    return this.raya._adoptTrack(track);
  }

  // ==================== Internal: Lavalink events ====================

  /** @internal */
  public _onEvent(event: CoreEvent): void {
    if (this.destroyed) return;
    switch (event.type) {
      case 'TrackStartEvent': {
        // Starts can arrive after we already moved on (fast skips): only announce the current track.
        if (!this.current || !isSameTrack(this.current, event.track)) {
          this.raya.debug(() => `[Player ${this.guildId}] ignoring stale TrackStartEvent for ${event.track.info.title}`);
          break;
        }
        this.announced.add(this.current);
        this.clearQueueEndTimer();
        this.raya.emit('trackStart', this, this.current);
        break;
      }
      case 'TrackEndEvent':
        this.onTrackEnd(event.track, event.reason);
        break;
      case 'TrackExceptionEvent':
        this.raya.emit('trackError', this, this.resolveTrack(event.track), event.exception);
        break;
      case 'TrackStuckEvent': {
        const track = this.resolveTrack(event.track);
        this.raya.emit('trackStuck', this, track, event.thresholdMs);
        if (this.defaults.skipOnStuck && this.current === track) {
          this.skip().catch((error) => this.emitError(error));
        }
        break;
      }
      case 'WebSocketClosedEvent':
        this.onVoiceSocketClosed(event.code, event.reason, event.byRemote);
        break;
    }
  }

  private onTrackEnd(lavalinkTrack: LavalinkTrack, reason: TrackEndReason): void {
    const track = this.resolveTrack(lavalinkTrack, reason === 'replaced' || reason === 'stopped');
    this.raya.debug(() => `[Player ${this.guildId}] track ended "${track.info.title}" (${reason})`);
    if (this.replaced === track && (reason === 'replaced' || reason === 'stopped')) this.replaced = null;
    // Keep trackStart/trackEnd paired: a track replaced before it was announced ends silently.
    const announced = this.announced.delete(track);
    if (announced || reason === 'finished' || reason === 'loadFailed') {
      this.raya.emit('trackEnd', this, track, reason);
    }

    if (reason !== 'finished' && reason !== 'loadFailed') return;
    if (!this.current) return; // stopped on purpose
    if (isSameTrack(this.transitioning, lavalinkTrack)) return; // already advancing
    if (!isSameTrack(this.current, lavalinkTrack)) {
      this.raya.debug(() => `[Player ${this.guildId}] ignoring stale end of "${lavalinkTrack.info.title}", "${this.current?.info.title}" is playing`);
      return;
    }

    if (reason === 'loadFailed') this.failures++;
    else this.failures = 0;
    void this.advance(this.current, reason);
  }

  /** @internal */
  public _onPlayerUpdate(state: LavalinkPlayerState): void {
    if (this.destroyed) return;
    if (this.current && !this.frozen) {
      this.anchorPosition = state.position;
      this.anchorTime = Date.now();
    }
    this.connected = state.connected;
    this.ping = state.ping;
    this.raya.emit('playerUpdate', this, state);
  }

  private onVoiceSocketClosed(code: number, reason: string, byRemote: boolean): void {
    this.connected = false;
    this.raya.debug(() => `[Player ${this.guildId}] Discord voice connection closed (code ${code}${reason ? `: ${reason}` : ''})`);
    this.raya.emit('socketClosed', this, { code, reason, byRemote });
    switch (code) {
      case 4006: // session no longer valid
      case 4009: // session timeout
      case 4015: // voice server crashed
        void this.reconnectVoice();
        break;
      case 4014: // kicked, channel deleted or voice server changed: give Discord a moment to tell us which
        this.scheduleVoiceRecovery(2500);
        break;
    }
  }

  // ==================== Internal: Discord voice ====================

  /** @internal */
  public _onVoiceState(state: GatewayVoiceState): void {
    if (this.destroyed) return;
    if (!state.channel_id) {
      // A player that never joined ignores this (e.g. the leave of a previous player in this guild).
      const wasInVoice = Boolean(this.voice.sessionId);
      this.voice = {};
      this.forwardedVoiceKey = null;
      this.connected = false;
      if (this.leaving || this.rejoining || !wasInVoice) return;
      this.cancelVoiceRecovery();
      const old = this.voiceChannelId;
      this.raya.debug(() => `[Player ${this.guildId}] bot was disconnected from voice channel ${old}`);
      this.voiceChannelId = null;
      this.raya.emit('playerMove', this, old, null);
      if (this.defaults.destroyOnVoiceDisconnect) {
        void this.destroy({ reason: 'voiceDisconnected', disconnect: false });
      }
      return;
    }
    const old = this.voiceChannelId;
    this.raya.debug(() => `[Player ${this.guildId}] voice state received (channel ${state.channel_id})`);
    this.voiceChannelId = state.channel_id;
    this.voice.sessionId = state.session_id;
    this.voice.channelId = state.channel_id;
    if (old !== state.channel_id) this.raya.emit('playerMove', this, old, state.channel_id);
    this.forwardVoice();
  }

  /** @internal */
  public _onVoiceServer(update: GatewayVoiceServerUpdate): void {
    if (this.destroyed) return;
    if (!update.endpoint) {
      this.raya.debug(() => `[Player ${this.guildId}] voice server deallocated, waiting for a new one`);
      return;
    }
    this.raya.debug(() => `[Player ${this.guildId}] voice server received (${update.endpoint})`);
    this.voice.token = update.token;
    this.voice.endpoint = update.endpoint;
    this.raya._routeByRegion(this, update.endpoint);
    this.forwardVoice();
  }

  private forwardVoice(): void {
    const { sessionId, token, endpoint, channelId } = this.voice;
    if (!sessionId || !token || !endpoint) return;
    const key = voiceKey(this.voice);
    if (key === this.forwardedVoiceKey) {
      this.resolveVoiceWaiters();
      return;
    }
    if (!this.node.connected) return; // sent when the node recovers
    this.forwardedVoiceKey = key;
    this._voiceStale = false;
    const voice: VoiceState = { token, endpoint, sessionId };
    if (channelId) voice.channelId = channelId;
    this._update({ voice }).then(
      () => {
        this.cancelVoiceRecovery();
        this.resolveVoiceWaiters();
        this.raya.debug(() => `[Player ${this.guildId}] voice forwarded to node ${this.node.name}`);
      },
      (error: Error) => {
        if (this.forwardedVoiceKey === key) this.forwardedVoiceKey = null;
        this.rejectVoiceWaiters(error);
        if (!this.destroyed) this.emitError(error);
      },
    );
  }

  private async reconnectVoice(): Promise<void> {
    const channelId = this.voiceChannelId;
    if (this.rejoining || this.destroyed || !channelId) return;
    this.rejoining = true;
    this.raya.debug(() => `[Player ${this.guildId}] reconnecting voice`);
    try {
      this.voice = {};
      this.forwardedVoiceKey = null;
      await this.sendVoiceUpdate(null);
      await sleep(500);
      if (this.destroyed) return;
      this._voiceStale = false;
      await this.connect({ channelId });
    } catch (error) {
      if (!this.destroyed) this.emitError(error);
    } finally {
      this.rejoining = false;
    }
  }

  private scheduleVoiceRecovery(delay: number): void {
    this.cancelVoiceRecovery();
    const key = this.forwardedVoiceKey;
    this.voiceRecoveryTimer = setTimeout(() => {
      this.voiceRecoveryTimer = null;
      if (!this.destroyed && this.voiceChannelId && this.forwardedVoiceKey === key) void this.reconnectVoice();
    }, delay);
    this.voiceRecoveryTimer.unref();
  }

  private cancelVoiceRecovery(): void {
    if (this.voiceRecoveryTimer) {
      clearTimeout(this.voiceRecoveryTimer);
      this.voiceRecoveryTimer = null;
    }
  }

  private resolveVoiceWaiters(): void {
    const channelId = this.voice.channelId;
    this.voiceWaiters = this.voiceWaiters.filter((waiter) => {
      if (channelId && waiter.channelId !== channelId) return true;
      clearTimeout(waiter.timer);
      waiter.resolve();
      return false;
    });
  }

  private rejectVoiceWaiters(error: Error, channelId?: string): void {
    this.voiceWaiters = this.voiceWaiters.filter((waiter) => {
      if (channelId && waiter.channelId !== channelId) return true;
      clearTimeout(waiter.timer);
      waiter.reject(error);
      return false;
    });
  }

  // ==================== Internal: recovery ====================

  /** @internal Freeze the position clock while the node is unreachable. */
  public _freeze(): void {
    if (this.frozen) return;
    this.anchorPosition = this.position;
    this.anchorTime = Date.now();
    this.frozen = true;
    this.connected = false;
  }

  /** @internal Re-create this player's full state on its node (after session loss or a node move). */
  public async _rebuild(): Promise<void> {
    if (this.destroyed) return;
    this._orphaned = false;
    const position = this.position;
    this.anchorPosition = position;
    this.anchorTime = Date.now();
    this.frozen = false;
    this.forwardedVoiceKey = null;

    const { sessionId, token, endpoint, channelId } = this.voice;
    const voiceUsable = !this._voiceStale && Boolean(sessionId && token && endpoint);
    if (!voiceUsable && this.voiceChannelId && (this._voiceStale || sessionId)) {
      await this.reconnectVoice();
      if (this.destroyed) return;
    }

    const payload: UpdatePlayerPayload = {
      volume: this.volume,
      paused: this.paused,
      filters: this.filters._payload(),
    };
    if (voiceUsable) {
      payload.voice = { sessionId: sessionId!, token: token!, endpoint: endpoint! };
      if (channelId) payload.voice.channelId = channelId;
      this.forwardedVoiceKey = voiceKey(this.voice);
    }
    if (this.current) {
      payload.track = { encoded: this.current.encoded };
      if (this.current.userData && Object.keys(this.current.userData).length) payload.track.userData = this.current.userData;
      if (position > 0 && this.current.info.isSeekable) payload.position = position;
      this.anchorPosition = this.current.info.isSeekable ? position : 0;
      this.anchorTime = Date.now();
    }
    try {
      await this._update(payload);
      if (voiceUsable) this.resolveVoiceWaiters();
      this.raya.emit('playerResume', this);
    } catch (error) {
      this.forwardedVoiceKey = null;
      throw error;
    }
  }

  /** @internal Adopt the state Lavalink kept for this player during a resumed session. */
  public _syncFromRemote(remote: LavalinkPlayer): void {
    if (this.destroyed) return;
    this._orphaned = false;
    this._hasRemoteState = true;
    this.volume = remote.volume;
    this.paused = remote.paused;
    this.filters._load(remote.filters);
    this.connected = remote.state.connected;
    this.ping = remote.state.ping;
    this.frozen = false;
    if (remote.voice?.token && remote.voice.endpoint && remote.voice.sessionId) {
      this.voice = { ...remote.voice, channelId: remote.voice.channelId ?? this.voiceChannelId ?? undefined };
      this.forwardedVoiceKey = voiceKey(this.voice);
      this._voiceStale = false;
    }
    if (remote.track) {
      if (!isSameTrack(this.current, remote.track)) this.current = this.raya._adoptTrack(remote.track);
      this.announced.add(this.current!);
      this.anchorPosition = remote.state.position;
      this.anchorTime = Date.now();
    } else if (this.current) {
      // The track ended while we were away.
      void this.advance(this.current, 'finished');
    }
    this.raya.emit('playerResume', this);
  }

  /** @internal */
  public _applySnapshot(snapshot: PlayerSnapshot): void {
    this.queue._restore(snapshot.queue ?? [], snapshot.history ?? []);
    this.current = snapshot.track ?? null;
    this.anchorPosition = snapshot.position ?? 0;
    this.anchorTime = Date.now();
    this.frozen = true;
    this.paused = snapshot.paused ?? false;
    this.filters._load(snapshot.filters ?? {});
    this.voice = { ...(snapshot.voice ?? {}) };
    this._voiceStale = true;
    for (const [key, value] of Object.entries(snapshot.data ?? {})) this.data.set(key, value);
  }

  /** @internal Stop local timers without touching Lavalink (process shutdown). */
  public _shutdown(): void {
    this.destroyed = true;
    this.clearTimers();
    this.rejectVoiceWaiters(new RayaError('PLAYER_DESTROYED', 'Raya is shutting down'));
  }

  // ==================== Internal: empty channel ====================

  /** @internal */
  public _setChannelEmpty(empty: boolean): void {
    if (this.destroyed) return;
    if (empty) {
      if (this.emptySince !== null) return;
      this.emptySince = Date.now();
      this.raya.emit('voiceChannelEmpty', this);
      if (this.defaults.pauseOnEmpty && this.current && !this.paused) {
        this.pausedByEmpty = true;
        this.setPaused(true).catch((error) => {
          this.pausedByEmpty = false;
          this.emitError(error);
        });
      }
      const timeout = this.defaults.emptyChannelTimeout;
      if (timeout !== false) {
        this.emptyTimer = setTimeout(() => {
          this.emptyTimer = null;
          void this.destroy({ reason: 'channelEmpty' });
        }, timeout);
        this.emptyTimer.unref();
      }
    } else {
      if (this.emptySince === null) return;
      this.emptySince = null;
      if (this.emptyTimer) {
        clearTimeout(this.emptyTimer);
        this.emptyTimer = null;
      }
      this.raya.emit('voiceChannelFilled', this);
      if (this.pausedByEmpty) {
        this.pausedByEmpty = false;
        this.setPaused(false).catch((error) => this.emitError(error));
      }
    }
  }

  // ==================== Helpers ====================

  private startQueueEndTimer(): void {
    this.clearQueueEndTimer();
    const timeout = this.defaults.queueEndTimeout;
    if (timeout === false) return;
    this.queueEndTimer = setTimeout(() => {
      this.queueEndTimer = null;
      if (!this.current) void this.destroy({ reason: 'queueEnd' });
    }, timeout);
    this.queueEndTimer.unref();
  }

  private clearQueueEndTimer(): void {
    if (this.queueEndTimer) {
      clearTimeout(this.queueEndTimer);
      this.queueEndTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearQueueEndTimer();
    this.cancelVoiceRecovery();
    if (this.emptyTimer) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
    }
  }

  private emitError(error: unknown): void {
    this.raya.emit('playerError', this, error instanceof Error ? error : new Error(String(error)));
  }

  private assertAlive(): void {
    if (this.destroyed) throw new RayaError('PLAYER_DESTROYED', `Player for guild ${this.guildId} was destroyed`);
  }
}

function clampVolume(volume: number): number {
  return Math.round(Math.min(1000, Math.max(0, volume)));
}
