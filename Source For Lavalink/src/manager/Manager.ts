/**
 * Manager - High-level API for the Lavalink client library
 * Provides convenient methods for managing players, nodes, and voice connections
 */

import { LavalinkEventEmitter } from './events';
import type { ManagerEvents } from './events';
import { VoiceForwarder } from './VoiceForwarder';
import { NodeManager } from '../nodes/NodeManager';
import { Player } from '../player/Player';
import type { Node } from '../nodes/Node';
import type {
  ManagerOptions,
  PlayerOptions,
  DiscordVoiceEvent,
  NodeOptions,
  SearchPlatformType,
  LoadResult,
  PlayerResponse,
  DaveOptions,
  DaveReadinessReport,
  DaveNodeStatus,
  StartupDiagnosticReport,
  StartupNodeDiagnostic,
} from '../types/lavalink';

type ResolvedManagerOptions = Omit<Required<ManagerOptions>, 'dave'> & {
  dave: DaveOptions;
};

/**
 * Plugin interface for lavaflow
 */
export interface LavaPlugin {
  name: string;
  onLoad?(manager: Manager): void | Promise<void>;
  onUnload?(manager: Manager): void | Promise<void>;
  onEvent?(event: string, ...args: unknown[]): void;
}

export class Manager extends LavalinkEventEmitter {
  public readonly options: ResolvedManagerOptions;
  private nodeManager: NodeManager;
  private voiceForwarder: VoiceForwarder | null = null;
  private players: Map<string, Player> = new Map();
  private clientId: string | null = null;
  private initialized: boolean = false;
  private debugEnabled: boolean = false;
  private plugins: LavaPlugin[] = [];
  /**
   * Register a plugin
   */
  public use(plugin: LavaPlugin): void {
    this.plugins.push(plugin);
    if (plugin.onLoad) {
      plugin.onLoad(this);
    }
    this.emit('debug', `Plugin loaded: ${plugin.name}`);
  }

  /**
   * Unload all plugins
   */
  public unloadPlugins(): void {
    for (const plugin of this.plugins) {
      if (plugin.onUnload) {
        plugin.onUnload(this);
      }
      this.emit('debug', `Plugin unloaded: ${plugin.name}`);
    }
    this.plugins = [];
  }

  constructor(options: ManagerOptions) {
    super();

    this.options = {
      nodes: options.nodes,
      send: options.send,
      clientId: options.clientId ?? '',
      shards: options.shards ?? 1,
      autoPlay: options.autoPlay ?? true,
      defaultSearchPlatform: options.defaultSearchPlatform ?? 'spsearch',
      debug: options.debug ?? false,
      maxQueueSize: options.maxQueueSize ?? 1000,
      apiRateLimitDelay: options.apiRateLimitDelay ?? 50,
      healthCheckInterval: options.healthCheckInterval ?? 60000,
      autoMovePlayersOnNodeDisconnect: options.autoMovePlayersOnNodeDisconnect ?? true,
      dave: {
        enabled: options.dave?.enabled ?? true,
        maxProtocolVersion: options.dave?.maxProtocolVersion ?? 1,
        minLavalinkVersion: options.dave?.minLavalinkVersion ?? '4.20.0',
      },
    };

    this.debugEnabled = this.options.debug;
    this.nodeManager = NodeManager.getInstance();
    this.setupInternalEventHandlers();
  }

  /**
   * Override emit to filter debug events based on debug flag
   */
  public emit<K extends keyof ManagerEvents>(event: K, ...args: ManagerEvents[K]): boolean {
    if (event === 'debug' && !this.debugEnabled) {
      return false;
    }
    // Call plugin event hooks
    for (const plugin of this.plugins) {
      if (plugin.onEvent) {
        try { plugin.onEvent(event as string, ...args); } catch {}
      }
    }
    return super.emit(event, ...args);
  }

  /**
   * Initialize the manager
   * Must be called before using the manager
   */
  public async init(clientId?: string): Promise<void> {
    if (this.initialized) {
      throw new Error('Manager already initialized');
    }

    this.clientId = clientId ?? this.options.clientId;
    if (!this.clientId) {
      throw new Error('Client ID is required');
    }

    // Initialize node manager
    this.nodeManager.init(this.clientId, this, this.options.healthCheckInterval);

    // Initialize voice forwarder
    this.voiceForwarder = new VoiceForwarder(
      this.clientId,
      this.options.send,
      this
    );

    // Mark as initialized before adding nodes
    this.initialized = true;

    // Add all configured nodes
    for (const nodeOptions of this.options.nodes) {
      try {
        await this.addNode(nodeOptions);
      } catch (error) {
        this.emit('debug', `Failed to connect to node ${nodeOptions.name}: ${error}`);
        const failedNode = this.nodeManager.getNode(nodeOptions.name);
        if (failedNode) {
          this.emit('nodeError', failedNode, error as Error);
        }
      }
    }

    this.emit('debug', 'Manager initialized');
  }

  /**
   * Check if manager is initialized
   */
  public isInitialized(): boolean {
    return this.initialized;
  }

  // ==================== Node Management ====================

  /**
   * Add a node
   */
  public async addNode(options: NodeOptions): Promise<Node> {
    if (!this.initialized) {
      throw new Error('Manager not initialized');
    }

    const node = await this.nodeManager.addNode(options);
    this.setupNodeEventHandlers(node);
    return node;
  }

  /**
   * Remove a node
   */
  public removeNode(name: string): boolean {
    return this.nodeManager.removeNode(name);
  }

  /**
   * Get a node by name
   */
  public getNode(name: string): Node | undefined {
    return this.nodeManager.getNode(name);
  }

  /**
   * Get all nodes
   */
  public getNodes(): Node[] {
    return this.nodeManager.getNodes();
  }

  /**
   * Get the best available node
   */
  public getBestNode(): Node {
    return this.nodeManager.getBestNode();
  }

  /**
   * Get metrics for all nodes
   */
  public getNodeMetrics() {
    return this.nodeManager.getNodeMetrics();
  }

  /**
   * Get metrics for a specific node
   */
  public getNodeMetricsById(name: string) {
    return this.nodeManager.getNodeMetricsById(name);
  }

  /**
   * Get Lavalink version of a specific node
   */
  public async getNodeVersion(name: string): Promise<string> {
    const node = this.getNode(name);
    if (!node) {
      throw new Error(`Node ${name} not found`);
    }
    return this.resolveNodeVersion(node);
  }

  /**
   * Get Lavalink versions for all connected nodes
   */
  public async getNodeVersions(): Promise<Map<string, string>> {
    const versions = new Map<string, string>();

    for (const node of this.getNodes()) {
      if (!node.isConnected()) {
        continue;
      }

      try {
        versions.set(node.options.name, await this.resolveNodeVersion(node));
      } catch {
        versions.set(node.options.name, 'unknown');
      }
    }

    return versions;
  }

  /**
   * Get all session players from a specific node
   */
  public async getSessionPlayers(nodeName: string): Promise<PlayerResponse[]> {
    const node = this.getNode(nodeName);
    if (!node) {
      throw new Error(`Node ${nodeName} not found`);
    }
    return node.getSessionPlayers();
  }

  /**
   * Get DAVE readiness report based on connected Lavalink nodes and manager capabilities.
   * Note: this validates server/runtime readiness only; actual DAVE negotiation occurs in Discord voice infrastructure.
   */
  public async getDaveReadinessReport(): Promise<DaveReadinessReport> {
    const statuses: DaveNodeStatus[] = [];

    for (const node of this.getNodes()) {
      if (!node.isConnected()) {
        continue;
      }

      try {
        const version = (await this.resolveNodeVersion(node)).trim();
        const compatible = this.isVersionGte(version, this.options.dave.minLavalinkVersion);

        statuses.push({
          node: node.options.name,
          version,
          compatible,
          reason: compatible
            ? undefined
            : `Requires >= ${this.options.dave.minLavalinkVersion}`,
        });
      } catch {
        statuses.push({
          node: node.options.name,
          version: 'unknown',
          compatible: false,
          reason: 'Unable to read Lavalink version',
        });
      }
    }

    const compatibleNodes = statuses.filter((s) => s.compatible);
    const incompatibleNodes = statuses.filter((s) => !s.compatible);

    return {
      enabled: this.options.dave.enabled,
      maxProtocolVersion: this.options.dave.maxProtocolVersion,
      minLavalinkVersion: this.options.dave.minLavalinkVersion,
      compatibleNodes,
      incompatibleNodes,
      summary: {
        connectedNodes: statuses.length,
        compatibleNodeCount: compatibleNodes.length,
        ready: this.options.dave.enabled
          ? compatibleNodes.length > 0
          : false,
      },
    };
  }

  /**
   * Run startup diagnostics for all configured nodes.
   */
  public async runStartupDiagnostics(): Promise<StartupDiagnosticReport> {
    const nodeDiagnostics: StartupNodeDiagnostic[] = [];

    for (const node of this.getNodes()) {
      const diagnostic: StartupNodeDiagnostic = {
        name: node.options.name,
        connected: node.isConnected(),
        version: 'unknown',
        versionSource: 'unknown',
        infoAvailable: false,
        statsAvailable: false,
      };

      if (node.isConnected()) {
        try {
          const info = await node.getInfo();
          diagnostic.infoAvailable = true;
          if (info.version?.semver) {
            diagnostic.version = info.version.semver;
            diagnostic.versionSource = 'info';
          }
        } catch (error) {
          diagnostic.error = error instanceof Error ? error.message : String(error);
        }

        if (diagnostic.versionSource === 'unknown') {
          try {
            diagnostic.version = await node.getVersion();
            diagnostic.versionSource = 'version';
          } catch (error) {
            diagnostic.error = diagnostic.error ?? (error instanceof Error ? error.message : String(error));
          }
        }

        try {
          await node.getStats();
          diagnostic.statsAvailable = true;
        } catch (error) {
          diagnostic.error = diagnostic.error ?? (error instanceof Error ? error.message : String(error));
        }
      }

      nodeDiagnostics.push(diagnostic);
    }

    const connectedNodes = nodeDiagnostics.filter((n) => n.connected).length;
    const healthyNodes = nodeDiagnostics.filter(
      (n) => n.connected && n.infoAvailable && n.statsAvailable
    ).length;

    return {
      timestamp: Date.now(),
      totalNodes: nodeDiagnostics.length,
      connectedNodes,
      healthyNodes,
      nodes: nodeDiagnostics,
    };
  }

  // ==================== Player Management ====================

  /**
   * Create a player for a guild
   */
  public create(options: PlayerOptions): Player {
    if (!this.initialized) {
      throw new Error('Manager not initialized');
    }

    if (this.players.has(options.guildId)) {
      return this.players.get(options.guildId)!;
    }

    const node = this.getBestNode();
    const player = new Player(
      options,
      node,
      this,
      this.options.autoPlay,
      this.options.defaultSearchPlatform,
      {
        maxQueueSize: this.options.maxQueueSize,
        apiRateLimitDelay: this.options.apiRateLimitDelay,
      }
    );

    this.players.set(options.guildId, player);
    this.emit('playerCreate', player);

    // Send voice state update to Discord
    this.voiceForwarder!.sendVoiceUpdate(
      options.guildId,
      options.voiceChannelId,
      {
        selfMute: options.selfMute,
        selfDeaf: options.selfDeafen,
      }
    );

    return player;
  }

  /**
   * Get a player by guild ID
   */
  public get(guildId: string): Player | undefined {
    return this.players.get(guildId);
  }

  /**
   * Destroy a player
   */
  public async destroyPlayer(guildId: string): Promise<boolean> {
    const player = this.players.get(guildId);
    if (!player) {
      return false;
    }

    await player.destroy();
    this.players.delete(guildId);

    // Send voice state update to leave the channel
    this.voiceForwarder!.sendVoiceUpdate(guildId, null);
    this.voiceForwarder!.clearVoiceState(guildId);

    return true;
  }

  /**
   * Get all players
   */
  public getPlayers(): Player[] {
    return Array.from(this.players.values());
  }

  /**
   * Check if a player exists for a guild
   */
  public has(guildId: string): boolean {
    return this.players.has(guildId);
  }

  // ==================== Voice Management ====================

  /**
   * Update voice state from Discord events
   * Call this from your Discord client's raw event handler
   */
  public updateVoiceState(packet: DiscordVoiceEvent | any): void {
    if (!this.voiceForwarder) {
      throw new Error('Manager not initialized');
    }

    // Handle both typed packets and raw Discord.js packets
    if (!packet.t || !packet.d) {
      return;
    }

    const eventType = packet.t;
    if (eventType !== 'VOICE_SERVER_UPDATE' && eventType !== 'VOICE_STATE_UPDATE') {
      return;
    }

    const guildId = packet.d.guild_id;
    const player = this.players.get(guildId);

    this.voiceForwarder.handleVoiceUpdate(packet, player).catch((error) => {
      this.emit(
        'debug',
        `Voice update handling error for guild ${guildId}: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  // ==================== Convenience Methods ====================

  /**
   * Search for tracks using the default search platform
   */
  public async search(
    query: string,
    platform?: SearchPlatformType
  ): Promise<LoadResult> {
    const node = this.getBestNode();
    const searchPlatform = platform ?? this.options.defaultSearchPlatform;

    // If query is a URL, don't add search prefix
    const isUrl = /^https?:\/\//.test(query);
    const identifier = isUrl ? query : `${searchPlatform}:${query}`;

    return node.loadTracks(identifier);
  }

  /**
   * Load tracks from a URL or identifier
   */
  public async load(identifier: string): Promise<LoadResult> {
    const node = this.getBestNode();
    return node.loadTracks(identifier);
  }

  /**
   * Decode a track
   */
  public async decodeTrack(encoded: string): Promise<any> {
    const node = this.getBestNode();
    return node.decodeTrack(encoded);
  }

  /**
   * Decode multiple tracks
   */
  public async decodeTracks(encoded: string[]): Promise<any[]> {
    const node = this.getBestNode();
    return node.decodeTracks(encoded);
  }

  // ==================== Statistics ====================

  /**
   * Get aggregate statistics from all nodes
   */
  public getStats(): ReturnType<NodeManager['getAggregateStats']> {
    return this.nodeManager.getAggregateStats();
  }

  /**
   * Get node penalties for load balancing inspection
   */
  public getNodePenalties(): Map<string, number> {
    return this.nodeManager.getNodePenalties();
  }

  /**
   * Get detailed penalty breakdown for all nodes
   */
  public getNodePenaltyDetails(): Map<string, any> {
    return this.nodeManager.getNodePenaltyDetails();
  }

  /**
   * Perform health check on all nodes
   */
  public async healthCheck(): Promise<Map<string, boolean>> {
    return this.nodeManager.healthCheck();
  }

  // ==================== Cleanup ====================

  /**
   * Destroy all players and disconnect from all nodes
   */
  public async destroyAll(): Promise<void> {
    // Destroy all players
    for (const [guildId] of this.players) {
      await this.destroyPlayer(guildId);
    }

    // Disconnect all nodes
    this.nodeManager.disconnectAll();

    // Clear voice states
    this.voiceForwarder?.clearAllVoiceStates();

    this.initialized = false;
    this.unloadPlugins();
    this.emit('debug', 'Manager destroyed');
  }

  // ==================== Private Methods ====================

  /**
   * Setup event handlers for a node
   */
  private setupNodeEventHandlers(node: Node): void {
    node.on('onTrackStart', (event) => {
      const player = this.players.get(event.guildId);
      if (player) {
        this.emit('trackStart', player, event.track);
      }
    });

    node.on('onTrackEnd', (event) => {
      const player = this.players.get(event.guildId);
      if (player) {
        player.handleTrackEnd(event.track, event.reason).catch((error) => {
          this.emit('debug', `Error handling track end: ${error.message}`);
        });
        this.emit('trackEnd', player, event.track, event.reason);
      }
    });

    node.on('onTrackException', (event) => {
      const player = this.players.get(event.guildId);
      if (player) {
        this.emit('trackException', player, event.track, event.exception);
      }
    });

    node.on('onTrackStuck', (event) => {
      const player = this.players.get(event.guildId);
      if (player) {
        this.emit('trackStuck', player, event.track, event.thresholdMs);
      }
    });

    node.on('onWebSocketClosed', (event) => {
      const player = this.players.get(event.guildId);
      if (player) {
        this.emit('socketClosed', player, event.code, event.reason, event.byRemote);
      }
    });

    node.on('onPlayerUpdate', (guildId, state) => {
      const player = this.players.get(guildId);
      if (player) {
        player.updateState({
          volume: player.volume,
          paused: player.paused,
          position: state.position,
          connected: state.connected,
          ping: state.ping,
        });
      }
    });
  }

  private setupInternalEventHandlers(): void {
    this.on('nodeDisconnect', (node) => {
      if (!this.options.autoMovePlayersOnNodeDisconnect) {
        return;
      }

      this.migratePlayersFromNode(node).catch((error) => {
        this.emit(
          'debug',
          `Automatic failover failed for node ${node.options.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    });
  }

  private async migratePlayersFromNode(disconnectedNode: Node): Promise<void> {
    const affectedPlayers = this.getPlayers().filter(
      (player) => player.node.options.name === disconnectedNode.options.name
    );

    if (affectedPlayers.length === 0) {
      return;
    }

    const connectedNodes = this.getNodes().filter(
      (node) => node.isConnected() && node.options.name !== disconnectedNode.options.name
    );

    if (connectedNodes.length === 0) {
      this.emit(
        'debug',
        `Failover skipped: no connected fallback nodes available for ${affectedPlayers.length} players`
      );
      return;
    }

    for (const player of affectedPlayers) {
      try {
        const targetNode = this.nodeManager.getBestNode();
        const fromNodeName = player.node.options.name;
        await player.migrateToNode(targetNode, { resumePlayback: true });
        this.emit('playerNodeMigrate', player, fromNodeName, targetNode.options.name);
      } catch (error) {
        this.emit(
          'debug',
          `Failed to migrate player ${player.guildId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private isVersionGte(version: string, minimum: string): boolean {
    const parse = (value: string): [number, number, number] => {
      const core = value.trim().replace(/^v/i, '').split('-')[0];
      if (!/^\d+\.\d+\.\d+$/.test(core)) {
        return [0, 0, 0];
      }
      const [major, minor, patch] = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
      return [major, minor, patch];
    };

    const [aMaj, aMin, aPatch] = parse(version);
    const [bMaj, bMin, bPatch] = parse(minimum);

    if (aMaj !== bMaj) return aMaj > bMaj;
    if (aMin !== bMin) return aMin > bMin;
    return aPatch >= bPatch;
  }

  private async resolveNodeVersion(node: Node): Promise<string> {
    try {
      const info = await node.getInfo();
      if (info.version?.semver) {
        return info.version.semver;
      }
    } catch {
      // Fallback to /version endpoint below
    }

    return node.getVersion();
  }
}
