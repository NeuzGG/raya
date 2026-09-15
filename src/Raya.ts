import { Node, NodeState } from './node/Node';
import { Player } from './player/Player';
import { defaultAutoplay } from './player/autoplay';
import { VoiceStatus } from './plugins/VoiceStatus';
import { TypedEmitter } from './utils/TypedEmitter';
import { LRUCache } from './utils/LRUCache';
import { VoiceStateCache } from './utils/VoiceStateCache';
import { RayaError } from './utils/errors';
import { decodeTrack } from './utils/TrackCodec';
import { buildIdentifier } from './utils/sources';
import { VERSION } from './version';
import type {
  CoreEvent,
  DiscordVoiceStateUpdatePayload,
  GatewayPacket,
  GatewayVoiceServerUpdate,
  GatewayVoiceState,
  LavalinkPlayer,
  LavalinkTrack,
  LoadResult,
  Lyrics,
  LyricsLine,
  PlayerUpdateOp,
  PluginEvent,
} from './types/lavalink';
import type {
  Connector,
  CreatePlayerOptions,
  NodeDisconnectInfo,
  NodeOptions,
  PlayerDestroyReason,
  RayaEvents,
  RayaOptions,
  RayaPlugin,
  RayaSnapshot,
  Requester,
  ResolvedPlayerDefaults,
  SearchOptions,
  SearchResult,
  Track,
} from './types/raya';

const CORE_EVENTS = new Set(['TrackStartEvent', 'TrackEndEvent', 'TrackExceptionEvent', 'TrackStuckEvent', 'WebSocketClosedEvent']);

/** Options people commonly put at the top level (e.g. coming from LavaFlow) that Raya would otherwise ignore silently. */
const MISPLACED_OPTIONS: Record<string, string> = {
  autoplay: 'playerDefaults.autoplay',
  autoPlay: 'playerDefaults.autoplay',
  defaultSearchPlatform: 'defaultSearchSource',
  volume: 'playerDefaults.volume',
  loop: 'playerDefaults.loop',
  maxQueueSize: 'playerDefaults.maxQueueSize',
  selfDeaf: 'playerDefaults.selfDeaf',
};

function warnMisplacedOptions(options: RayaOptions): void {
  for (const [key, replacement] of Object.entries(MISPLACED_OPTIONS)) {
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      process.emitWarning(`Raya option "${key}" is ignored. Use "${replacement}" instead.`, 'RayaWarning');
    }
  }
}

export interface RayaStats {
  nodes: number;
  readyNodes: number;
  players: number;
  playingPlayers: number;
  cache: { size: number; hits: number; misses: number } | null;
}

/**
 * Raya: the Lavalink v4 client.
 *
 * ```ts
 * const raya = new Raya({ nodes: [...], connector: new Connectors.DiscordJS(client) });
 * const player = await raya.join({ guildId, voiceChannelId, textChannelId });
 * await player.enqueue(await player.search('never gonna give you up', { requester: user }));
 * ```
 */
export class Raya extends TypedEmitter<RayaEvents> {
  public readonly nodes = new Map<string, Node>();
  public readonly players = new Map<string, Player>();
  public readonly clientName: string;
  public readonly playerDefaults: ResolvedPlayerDefaults;
  public readonly searchCache: LRUCache<string, LoadResult> | null;
  public userId: string | null = null;
  public initialized = false;
  public readonly connector: Connector | null;
  /** Voice channel status updater, when enabled with the `voiceStatus` option */
  public readonly voiceStatus: VoiceStatus | null;
  /** Search source used for queries that are not URLs */
  public readonly defaultSearchSource: string;

  private readonly options: RayaOptions;
  private readonly failoverEnabled: boolean;
  private readonly failoverDelay: number;
  private readonly inflight = new Map<string, Promise<LoadResult>>();
  private readonly voiceStates = new VoiceStateCache();
  private readonly plugins = new Map<string, RayaPlugin>();
  private readonly pendingDestroys = new Map<string, Promise<void>>();
  private readonly failoverTimers = new Map<Node, NodeJS.Timeout>();
  private readonly destroyHooks = new Set<(player: Player) => Promise<void> | void>();
  private initPromise: Promise<this> | null = null;
  private restore: RayaSnapshot | null;

  constructor(options: RayaOptions) {
    super();
    if (!options || !Array.isArray(options.nodes)) {
      throw new RayaError('INVALID_ARGUMENT', 'Raya needs a "nodes" array');
    }
    if (!options.send && !options.connector) {
      throw new RayaError('INVALID_ARGUMENT', 'Raya needs either a "connector" or a "send" function');
    }
    warnMisplacedOptions(options);
    this.options = options;
    this.connector = options.connector ?? null;
    if (options.debug) {
      this.on('debug', typeof options.debug === 'function' ? options.debug : (message) => console.log(`[Raya] ${message}`));
    }
    this.clientName = options.clientName ?? `Raya/${VERSION}`;
    this.defaultSearchSource = options.defaultSearchSource ?? 'youtube';
    this.failoverEnabled = options.failover?.enabled ?? true;
    this.failoverDelay = options.failover?.delay ?? 5000;
    this.restore = options.restore ?? null;

    const d = options.playerDefaults ?? {};
    this.playerDefaults = {
      volume: d.volume ?? 100,
      selfDeaf: d.selfDeaf ?? true,
      selfMute: d.selfMute ?? false,
      loop: d.loop ?? 'off',
      autoplay: d.autoplay ?? false,
      maxQueueSize: d.maxQueueSize ?? 10000,
      historySize: d.historySize ?? 50,
      queueEndTimeout: d.queueEndTimeout ?? false,
      emptyChannelTimeout: d.emptyChannelTimeout ?? false,
      pauseOnEmpty: d.pauseOnEmpty ?? false,
      skipOnStuck: d.skipOnStuck ?? true,
      destroyOnVoiceDisconnect: d.destroyOnVoiceDisconnect ?? true,
      voiceTimeout: d.voiceTimeout ?? 15000,
    };

    this.searchCache =
      options.searchCache === false
        ? null
        : new LRUCache(options.searchCache?.maxSize ?? 500, options.searchCache?.ttl ?? 300000);

    if (options.voiceStatus) {
      const plugin = new VoiceStatus(options.voiceStatus === true ? {} : options.voiceStatus);
      this.plugins.set(plugin.name, plugin);
      plugin.load(this);
      this.voiceStatus = plugin;
    } else {
      this.voiceStatus = null;
    }

    for (const nodeOptions of options.nodes) this.addNode(nodeOptions);
    this.debug(() => `Raya ${VERSION} created with ${this.nodes.size} node(s), default search source "${this.defaultSearchSource}"`);
    options.connector?.attach(this);
  }

  // ==================== Lifecycle ====================

  /**
   * Connect to every node. Resolves once each node's first connection attempt has settled;
   * nodes that failed keep retrying in the background. Safe to call more than once.
   */
  public init(userId?: string): Promise<this> {
    if (this.initPromise) return this.initPromise;
    const id = userId ?? this.userId;
    if (!id) return Promise.reject(new RayaError('INVALID_ARGUMENT', 'init() needs the bot user id'));
    this.userId = id;

    this.initPromise = (async () => {
      if (this.restore) {
        this.applySnapshot(this.restore);
        this.restore = null;
      }
      await Promise.allSettled(
        [...this.nodes.values()].map((node) =>
          node.connect().catch((error: RayaError) => {
            if (error.code !== 'NODE_AUTH_FAILED') this._onNodeError(node, error);
          }),
        ),
      );
      for (const node of this.nodes.values()) {
        if (!node.connected && node.players.size) this.scheduleFailover(node);
      }
      this.initialized = true;
      this.debug(() => `Initialized with ${this.readyNodes.length}/${this.nodes.size} ready nodes`);
      this.emit('ready');
      return this;
    })();
    return this.initPromise;
  }

  /**
   * Graceful restart: capture a snapshot and close node connections WITHOUT destroying
   * players. Lavalink keeps them playing for `resumeTimeout` seconds; pass the snapshot to
   * `new Raya({ restore })` in the next process to pick them up again.
   */
  public async shutdown(): Promise<RayaSnapshot> {
    await Promise.allSettled([...this.players.values()].map((player) => player._settle()));
    const snapshot = this.snapshot();
    for (const player of this.players.values()) player._shutdown();
    this.players.clear();
    for (const node of this.nodes.values()) {
      node.players.clear();
      node.disconnect(1000, 'Raya shutdown');
    }
    this.clearFailoverTimers();
    this.initPromise = null;
    this.initialized = false;
    return snapshot;
  }

  /** Destroy every player, close every node and unload plugins. */
  public async destroy(): Promise<void> {
    await Promise.allSettled([...this.players.values()].map((player) => player.destroy({ reason: 'manual' })));
    for (const node of this.nodes.values()) node.destroy();
    this.clearFailoverTimers();
    for (const plugin of [...this.plugins.values()].reverse()) {
      await Promise.resolve(plugin.unload?.(this)).catch(() => undefined);
    }
    this.plugins.clear();
    this.searchCache?.clear();
    this.initPromise = null;
    this.initialized = false;
  }

  /** Serializable state of every player, for persistence across restarts. */
  public snapshot(): RayaSnapshot {
    const sessions: Record<string, string> = {};
    for (const node of this.nodes.values()) if (node.sessionId) sessions[node.name] = node.sessionId;
    return {
      version: 1,
      createdAt: Date.now(),
      userId: this.userId,
      sessions,
      players: [...this.players.values()].filter((p) => !p.destroyed).map((p) => p.toJSON()),
    };
  }

  public async use(plugin: RayaPlugin): Promise<this> {
    if (this.plugins.has(plugin.name)) throw new RayaError('INVALID_ARGUMENT', `Plugin "${plugin.name}" is already loaded`);
    this.plugins.set(plugin.name, plugin);
    try {
      await plugin.load(this);
    } catch (error) {
      this.plugins.delete(plugin.name);
      throw error;
    }
    return this;
  }

  public get stats(): RayaStats {
    let playing = 0;
    for (const player of this.players.values()) if (player.playing) playing++;
    return {
      nodes: this.nodes.size,
      readyNodes: this.readyNodes.length,
      players: this.players.size,
      playingPlayers: playing,
      cache: this.searchCache
        ? { size: this.searchCache.size, hits: this.searchCache.hits, misses: this.searchCache.misses }
        : null,
    };
  }

  // ==================== Nodes ====================

  public get readyNodes(): Node[] {
    return [...this.nodes.values()].filter((node) => node.connected);
  }

  public getNode(name: string): Node | undefined {
    return this.nodes.get(name);
  }

  public addNode(options: NodeOptions): Node {
    const node = new Node(this, options);
    if (this.nodes.has(node.name)) throw new RayaError('NODE_EXISTS', `A node named "${node.name}" already exists`);
    this.nodes.set(node.name, node);
    this.emit('nodeAdd', node);
    if (this.initPromise) {
      node.connect().catch((error: RayaError) => {
        if (error.code !== 'NODE_AUTH_FAILED') this._onNodeError(node, error);
      });
    }
    return node;
  }

  /** Remove a node, moving its players to the remaining nodes. */
  public async removeNode(name: string): Promise<boolean> {
    const node = this.nodes.get(name);
    if (!node) return false;
    this.nodes.delete(name);
    this.cancelFailover(node);
    node.destroy();
    await this.evacuate(node);
    this.emit('nodeRemove', node);
    return true;
  }

  /** The least loaded ready node, preferring `region` when nodes declare regions. */
  public bestNode(context: { region?: string; guildId?: string; exclude?: Node } = {}): Node {
    let nodes = this.readyNodes;
    if (context.exclude) nodes = nodes.filter((node) => node !== context.exclude);
    if (nodes.length === 0) throw new RayaError('NO_NODES', 'No Lavalink node is ready');
    const selected = this.options.nodeSelector?.(nodes, { region: context.region, guildId: context.guildId });
    if (selected) return selected;
    if (context.region) {
      const regional = nodes.filter((node) => node.matchesRegion(context.region));
      if (regional.length) nodes = regional;
    }
    let best = nodes[0]!;
    let bestPenalty = best.penalty;
    for (let i = 1; i < nodes.length; i++) {
      const penalty = nodes[i]!.penalty;
      if (penalty < bestPenalty) {
        best = nodes[i]!;
        bestPenalty = penalty;
      }
    }
    return best;
  }

  // ==================== Players ====================

  /** Create a player (or return the existing one). Call `player.connect()` to join voice. */
  public createPlayer(options: CreatePlayerOptions): Player {
    if (!options || typeof options.guildId !== 'string' || typeof options.voiceChannelId !== 'string') {
      throw new RayaError('INVALID_ARGUMENT', 'createPlayer() needs "guildId" and "voiceChannelId"');
    }
    const existing = this.players.get(options.guildId);
    if (existing && !existing.destroyed) return existing;

    let node: Node;
    if (options.node) {
      const found = typeof options.node === 'string' ? this.nodes.get(options.node) : options.node;
      if (!found) throw new RayaError('NODE_NOT_FOUND', `Node "${String(options.node)}" does not exist`);
      if (!found.connected) throw new RayaError('NODE_NOT_READY', `Node "${found.name}" is not ready`);
      node = found;
    } else {
      node = this.bestNode({ region: options.region, guildId: options.guildId });
    }

    const player = new Player(this, node, options, this.playerDefaults, this.pendingDestroys.get(options.guildId));
    this.players.set(player.guildId, player);
    node.players.add(player);
    this.debug(() => `[Player ${player.guildId}] created on node ${node.name}`);
    this.emit('playerCreate', player);
    return player;
  }

  /** Create a player and join its voice channel in one step. */
  public async join(options: CreatePlayerOptions & { timeout?: number }): Promise<Player> {
    const existed = this.players.has(options.guildId);
    const player = this.createPlayer(options);
    try {
      await player.connect({ channelId: options.voiceChannelId, timeout: options.timeout });
    } catch (error) {
      if (!existed) await player.destroy({ reason: 'voiceTimeout' }).catch(() => undefined);
      throw error;
    }
    return player;
  }

  public getPlayer(guildId: string): Player | undefined {
    return this.players.get(guildId);
  }

  public async destroyPlayer(guildId: string, reason: PlayerDestroyReason = 'manual'): Promise<boolean> {
    const player = this.players.get(guildId);
    if (!player) return false;
    await player.destroy({ reason });
    return true;
  }

  // ==================== Search ====================

  /**
   * Search or load a URL. Results are normalized: `result.tracks` is always an array.
   * Identical concurrent searches share one request, and results are cached.
   */
  public async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    if (typeof query !== 'string' || !query.trim()) throw new RayaError('INVALID_ARGUMENT', 'Search query must be a non-empty string');
    const identifier = buildIdentifier(query, options.source ?? this.defaultSearchSource);
    const cache = options.cache !== false ? this.searchCache : null;

    let result = cache?.get(identifier);
    const cached = result !== undefined;
    if (!result) {
      result = await this.loadDeduplicated(identifier, options.node);
      if (cache && (result.loadType === 'track' || result.loadType === 'playlist' || result.loadType === 'search')) {
        cache.set(identifier, result);
      }
    }
    const normalized = this.normalize(result, identifier, cached, options.requester);
    this.debug(() => `Search "${identifier}" -> ${normalized.type} (${normalized.tracks.length} tracks)${cached ? ' [cached]' : ''}`);
    return normalized;
  }

  /** Decode an encoded track locally (no REST call). */
  public decodeTrack(encoded: string, requester?: Requester): Track {
    const track: Track = decodeTrack(encoded);
    if (requester !== undefined) track.requester = this._transformRequester(requester);
    return track;
  }

  public decodeTracks(encoded: string[], requester?: Requester): Track[] {
    return encoded.map((e) => this.decodeTrack(e, requester));
  }

  private loadDeduplicated(identifier: string, preferred?: string | Node): Promise<LoadResult> {
    const running = this.inflight.get(identifier);
    if (running) return running;
    let node: Node;
    if (preferred) {
      const found = typeof preferred === 'string' ? this.nodes.get(preferred) : preferred;
      if (!found) return Promise.reject(new RayaError('NODE_NOT_FOUND', `Node "${String(preferred)}" does not exist`));
      node = found;
    } else {
      node = this.bestNode();
    }
    const request = this.loadWithFallback(identifier, node).finally(() => this.inflight.delete(identifier));
    this.inflight.set(identifier, request);
    return request;
  }

  private async loadWithFallback(identifier: string, node: Node): Promise<LoadResult> {
    try {
      return await node.rest.loadTracks(identifier);
    } catch (error) {
      const code = (error as RayaError).code;
      if (code !== 'NETWORK_ERROR' && code !== 'REST_TIMEOUT') throw error;
      const fallback = this.readyNodes.filter((n) => n !== node).sort((a, b) => a.penalty - b.penalty)[0];
      if (!fallback) throw error;
      this.debug(() => `Search on "${node.name}" failed (${code}), retrying on "${fallback.name}"`);
      return fallback.rest.loadTracks(identifier);
    }
  }

  private normalize(result: LoadResult, identifier: string, cached: boolean, requester: Requester | undefined): SearchResult {
    const owner = requester === undefined ? undefined : this._transformRequester(requester);
    const wrap = (track: LavalinkTrack): Track => {
      const copy: Track = { ...track, userData: { ...(track.userData ?? {}) }, pluginInfo: track.pluginInfo ?? {} };
      if (owner !== undefined) copy.requester = owner;
      return copy;
    };
    const base = { identifier, cached, playlist: null, exception: null };
    switch (result?.loadType) {
      case 'track':
        return { ...base, type: 'track', tracks: [wrap(result.data)] };
      case 'search':
        return { ...base, type: 'search', tracks: result.data.map(wrap) };
      case 'playlist': {
        const tracks = result.data.tracks.map(wrap);
        return {
          ...base,
          type: 'playlist',
          tracks,
          playlist: {
            name: result.data.info.name,
            selectedTrack: result.data.info.selectedTrack,
            pluginInfo: result.data.pluginInfo ?? {},
            duration: tracks.reduce((sum, t) => sum + (t.info.isStream ? 0 : t.info.length), 0),
          },
        };
      }
      case 'error':
        return { ...base, type: 'error', tracks: [], exception: result.data };
      default:
        return { ...base, type: 'empty', tracks: [] };
    }
  }

  // ==================== Discord gateway ====================

  /**
   * Feed raw Discord gateway packets here (VOICE_STATE_UPDATE, VOICE_SERVER_UPDATE,
   * GUILD_CREATE, ...). Connectors do this for you.
   */
  public handleRaw(packet: GatewayPacket | unknown): void {
    if (!packet || typeof packet !== 'object') return;
    const { t, d } = packet as GatewayPacket;
    if (!t || !d || typeof d !== 'object') return;

    switch (t) {
      case 'VOICE_STATE_UPDATE': {
        const state = d as GatewayVoiceState;
        if (!state.guild_id) return;
        this.voiceStates.update(state);
        const player = this.players.get(state.guild_id);
        if (!player) return;
        if (state.user_id === this.userId) player._onVoiceState(state);
        this.evaluateChannel(player);
        break;
      }
      case 'VOICE_SERVER_UPDATE': {
        const update = d as GatewayVoiceServerUpdate;
        this.players.get(update.guild_id)?._onVoiceServer(update);
        break;
      }
      case 'GUILD_CREATE': {
        const guild = d as { id: string };
        this.voiceStates.seed(d as Parameters<VoiceStateCache['seed']>[0]);
        const player = this.players.get(guild.id);
        if (player) this.evaluateChannel(player);
        break;
      }
      case 'GUILD_DELETE': {
        const guild = d as { id: string; unavailable?: boolean };
        if (guild.unavailable) return;
        this.voiceStates.forget(guild.id);
        void this.players.get(guild.id)?.destroy({ reason: 'guildDeleted', disconnect: false });
        break;
      }
      case 'CHANNEL_DELETE': {
        const channel = d as { id: string; guild_id?: string };
        if (!channel.guild_id) return;
        const player = this.players.get(channel.guild_id);
        if (player?.voiceChannelId === channel.id) void player.destroy({ reason: 'channelDeleted', disconnect: false });
        break;
      }
    }
  }

  /** Alias of `handleRaw` for code migrating from other clients. */
  public updateVoiceState(packet: GatewayPacket | unknown): void {
    this.handleRaw(packet);
  }

  private evaluateChannel(player: Player): void {
    if (!player.voiceChannelId) return;
    const humans = this.voiceStates.countHumans(player.guildId, player.voiceChannelId, this.userId);
    if (humans === null) return;
    player._setChannelEmpty(humans === 0);
  }

  // ==================== Internal API ====================

  /** @internal */
  public debug(message: () => string): void {
    if (this.listenerCount('debug') > 0) this.emit('debug', message());
  }

  /** @internal */
  public requireUserId(): string {
    if (!this.userId) throw new RayaError('NOT_INITIALIZED', 'Call raya.init(userId) first');
    return this.userId;
  }

  /** @internal */
  public async _sendGateway(guildId: string, payload: DiscordVoiceStateUpdatePayload): Promise<void> {
    if (this.options.send) await this.options.send(guildId, payload);
    else await this.options.connector!.send(guildId, payload);
  }

  /** @internal */
  public _transformRequester(requester: unknown): Requester {
    return this.options.requesterTransformer ? this.options.requesterTransformer(requester) : (requester as Requester);
  }

  /** @internal */
  public _adoptTrack(track: LavalinkTrack): Track {
    return { ...track, userData: track.userData ?? {}, pluginInfo: track.pluginInfo ?? {} };
  }

  /** @internal */
  public async _resolveAutoplay(player: Player, track: Track): Promise<Track | null> {
    try {
      return (await (this.options.autoplayResolver ?? defaultAutoplay)(player, track)) ?? null;
    } catch (error) {
      this.emit('playerError', player, error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  /** @internal */
  public _addDestroyHook(hook: (player: Player) => Promise<void> | void): () => void {
    this.destroyHooks.add(hook);
    return () => this.destroyHooks.delete(hook);
  }

  /** @internal Runs work that must happen while the bot is still in voice, capped so leaving is never held up. */
  public _runDestroyHooks(player: Player): Promise<void> | null {
    if (this.destroyHooks.size === 0) return null;
    const tasks = Promise.all([...this.destroyHooks].map((hook) => Promise.resolve().then(() => hook(player)).catch(() => undefined)));
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 1500);
      timer.unref();
    });
    return Promise.race([tasks.then(() => undefined), cap]).finally(() => clearTimeout(timer));
  }

  /** @internal */
  public _detachPlayer(player: Player, cleanup: Promise<void>): void {
    if (this.players.get(player.guildId) === player) this.players.delete(player.guildId);
    player.node.players.delete(player);
    const pending = cleanup.catch(() => undefined);
    this.pendingDestroys.set(player.guildId, pending);
    void pending.then(() => {
      if (this.pendingDestroys.get(player.guildId) === pending) this.pendingDestroys.delete(player.guildId);
    });
  }

  /**
   * @internal Before a fresh player sends anything, move it to a node in the voice server's
   * region when such a node exists.
   */
  public _routeByRegion(player: Player, endpoint: string): void {
    if (player._hasRemoteState || player.current) return;
    const region = /^(?:c-)?([a-z]+)/i.exec(endpoint.replace(/^wss?:\/\//, ''))?.[1]?.toLowerCase();
    if (!region || player.node.matchesRegion(region)) return;
    const regional = this.readyNodes.filter((node) => node.matchesRegion(region));
    if (regional.length === 0) return;
    const target = regional.reduce((best, node) => (node.penalty < best.penalty ? node : best));
    player.node.players.delete(player);
    target.players.add(player);
    this.debug(() => `[Player ${player.guildId}] routed to node "${target.name}" for voice region "${region}"`);
    player.node = target;
  }

  /** @internal */
  public _onNodeError(node: Node, error: Error): void {
    this.emit('nodeError', node, error);
  }

  /** @internal */
  public _onNodeDisconnect(node: Node, info: NodeDisconnectInfo): void {
    this.emit('nodeDisconnect', node, info);
    for (const player of node.players) player._freeze();
    if (info.wasReady && node.players.size && node.state !== NodeState.Destroyed) this.scheduleFailover(node);
  }

  /** @internal */
  public _onNodeGone(node: Node): void {
    this.cancelFailover(node);
    void this.evacuate(node);
  }

  /** @internal */
  public _onNodeReady(node: Node, resumed: boolean): void {
    this.cancelFailover(node);
    this.emit('nodeReady', node, resumed);
    void this.recoverNode(node, resumed);
  }

  /** @internal */
  public _onPlayerUpdate(node: Node, payload: PlayerUpdateOp): void {
    const player = this.players.get(payload.guildId);
    if (player && player.node === node) player._onPlayerUpdate(payload.state);
  }

  /** @internal */
  public _onNodeEvent(node: Node, event: CoreEvent | PluginEvent): void {
    const player = this.players.get(event.guildId);
    if (!player || player.node !== node) {
      this.debug(() => `[Node ${node.name}] ${event.type} for unknown player ${event.guildId}`);
      return;
    }
    if (CORE_EVENTS.has(event.type)) {
      player._onEvent(event as CoreEvent);
      return;
    }

    const plugin = event as PluginEvent;
    this.emit('pluginEvent', player, plugin);
    switch (plugin.type) {
      case 'LyricsFoundEvent':
        this.emit('lyricsFound', player, plugin.lyrics as Lyrics);
        break;
      case 'LyricsNotFoundEvent':
        this.emit('lyricsNotFound', player);
        break;
      case 'LyricsLineEvent':
        this.emit('lyricsLine', player, plugin.line as LyricsLine, plugin.lineIndex as number, Boolean(plugin.skipped));
        break;
      case 'SegmentsLoaded':
        this.emit('segmentsLoaded', player, (plugin.segments as unknown[]) ?? []);
        break;
      case 'SegmentSkipped':
        this.emit('segmentSkipped', player, plugin.segment);
        break;
      case 'ChaptersLoaded':
        this.emit('chaptersLoaded', player, (plugin.chapters as unknown[]) ?? []);
        break;
      case 'ChapterStarted':
        this.emit('chapterStarted', player, plugin.chapter);
        break;
    }
  }

  // ==================== Recovery ====================

  private async recoverNode(node: Node, resumed: boolean): Promise<void> {
    const local = [...node.players];
    let remote: LavalinkPlayer[] | null = null;

    if (resumed) {
      try {
        remote = await node.rest.getPlayers();
      } catch (error) {
        this._onNodeError(node, error as Error);
      }
    }

    if (remote) {
      const byGuild = new Map(remote.map((p) => [p.guildId, p]));
      for (const player of local) {
        const state = byGuild.get(player.guildId);
        byGuild.delete(player.guildId);
        if (state) player._syncFromRemote(state);
        else this.rebuild(player);
      }
      // Players Lavalink kept that nobody controls any more would play forever: clean them up.
      for (const guildId of byGuild.keys()) {
        const owner = this.players.get(guildId);
        if (owner?.node === node) continue;
        this.debug(() => `[Node ${node.name}] destroying orphaned remote player ${guildId}`);
        node.rest.destroyPlayer(guildId).catch(() => undefined);
      }
    } else if (local.length) {
      this.debug(() => `[Node ${node.name}] session ${resumed ? 'state unavailable' : 'not resumed'}, rebuilding ${local.length} players`);
      for (const player of local) this.rebuild(player);
    }

    for (const player of this.players.values()) {
      if (player._orphaned && player.node !== node && !player.node.connected) {
        player._orphaned = false;
        player.moveNode(node).catch((error) => {
          player._orphaned = true;
          this.emit('playerError', player, error as Error);
        });
      }
    }
  }

  private rebuild(player: Player): void {
    player._rebuild().catch((error) => this.emit('playerError', player, error as Error));
  }

  private scheduleFailover(node: Node): void {
    if (!this.failoverEnabled || this.failoverTimers.has(node)) return;
    const timer = setTimeout(() => {
      this.failoverTimers.delete(node);
      if (!node.connected) void this.evacuate(node);
    }, this.failoverDelay);
    timer.unref();
    this.failoverTimers.set(node, timer);
  }

  private cancelFailover(node: Node): void {
    const timer = this.failoverTimers.get(node);
    if (timer) {
      clearTimeout(timer);
      this.failoverTimers.delete(node);
    }
  }

  private clearFailoverTimers(): void {
    for (const timer of this.failoverTimers.values()) clearTimeout(timer);
    this.failoverTimers.clear();
  }

  private async evacuate(node: Node): Promise<void> {
    const players = [...node.players].filter((player) => !player.destroyed);
    if (players.length === 0) return;
    this.debug(() => `[Node ${node.name}] moving ${players.length} players to other nodes`);
    await Promise.allSettled(
      players.map(async (player) => {
        let target: Node;
        try {
          target = this.bestNode({ exclude: node, guildId: player.guildId });
        } catch {
          player._orphaned = true;
          return;
        }
        try {
          await player.moveNode(target);
        } catch (error) {
          player._orphaned = true;
          this.emit('playerError', player, error as Error);
        }
      }),
    );
  }

  private applySnapshot(snapshot: RayaSnapshot): void {
    if (snapshot?.version !== 1) {
      this.debug(() => 'Ignoring snapshot with unsupported version');
      return;
    }
    if (snapshot.userId && snapshot.userId !== this.userId) {
      this.debug(() => 'Ignoring snapshot taken by a different bot user');
      return;
    }
    for (const [name, sessionId] of Object.entries(snapshot.sessions ?? {})) {
      const node = this.nodes.get(name);
      if (node && !node.sessionId) node.sessionId = sessionId;
    }
    const fallback = this.nodes.values().next().value as Node | undefined;
    for (const data of snapshot.players ?? []) {
      if (this.players.has(data.guildId)) continue;
      const node = this.nodes.get(data.node) ?? fallback;
      if (!node) break;
      const player = new Player(
        this,
        node,
        {
          guildId: data.guildId,
          voiceChannelId: data.voiceChannelId ?? '',
          textChannelId: data.textChannelId,
          selfDeaf: data.selfDeaf,
          selfMute: data.selfMute,
          volume: data.volume,
          loop: data.loop,
          autoplay: data.autoplay,
        },
        this.playerDefaults,
      );
      if (!data.voiceChannelId) player.voiceChannelId = null;
      player._applySnapshot(data);
      this.players.set(player.guildId, player);
      node.players.add(player);
      this.emit('playerCreate', player);
    }
    this.debug(() => `Restored ${snapshot.players?.length ?? 0} players from snapshot`);
  }
}
