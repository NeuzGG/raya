/**
 * Node class - Manages a single Lavalink node connection
 * Handles WebSocket lifecycle, heartbeat, and REST API calls
 */

import WebSocket from 'ws';
import { HttpClient } from '../utils/http';
import { ExponentialBackoff } from '../utils/backoff';
import type {
  NodeOptions,
  NodeStats,
  NodeInfo,
  LavalinkEvent,
  ReadyEvent,
  PlayerUpdateEvent,
  StatsEvent,
  TrackStartEvent,
  TrackEndEvent,
  TrackExceptionEvent,
  TrackStuckEvent,
  WebSocketClosedEvent,
  LoadResult,
  PlayerResponse,
  UpdatePlayerPayload,
} from '../types/lavalink';

export enum NodeState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
}

export interface NodeEventHandlers {
  onReady: (sessionId: string, resumed: boolean) => void;
  onPlayerUpdate: (guildId: string, state: PlayerUpdateEvent['state']) => void;
  onStats: (stats: NodeStats) => void;
  onTrackStart: (event: TrackStartEvent) => void;
  onTrackEnd: (event: TrackEndEvent) => void;
  onTrackException: (event: TrackExceptionEvent) => void;
  onTrackStuck: (event: TrackStuckEvent) => void;
  onWebSocketClosed: (event: WebSocketClosedEvent) => void;
  onConnect: () => void;
  onDisconnect: (code: number, reason: string) => void;
  onError: (error: Error) => void;
  onReconnecting: (attempt: number) => void;
}

export class Node {
  public readonly options: Required<NodeOptions>;
  public state: NodeState = NodeState.DISCONNECTED;
  public stats: NodeStats | null = null;
  public sessionId: string | null = null;
  public info: NodeInfo | null = null;

  private ws: WebSocket | null = null;
  private http: HttpClient;
  private backoff: ExponentialBackoff;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private eventHandlers: Partial<NodeEventHandlers> = {};
  private lastHeartbeat: number = 0;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private clientId: string | null = null;

  // Metrics
  private createdAt: number = Date.now();
  private lastDisconnect: number | null = null;
  private disconnectCount: number = 0;

  constructor(options: NodeOptions) {
    this.options = {
      name: options.name,
      host: options.host,
      port: options.port,
      password: options.password,
      secure: options.secure ?? false,
      resumeKey: options.resumeKey ?? 'lavaflow',
      resumeTimeout: options.resumeTimeout ?? 60,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 3,
      reconnectDelay: options.reconnectDelay ?? 5000,
      region: options.region,
      retryStrategy: options.retryStrategy ?? 'exponential',
    } as Required<NodeOptions>;

    this.http = new HttpClient({
      host: this.options.host,
      port: this.options.port,
      password: this.options.password,
      secure: this.options.secure,
    });

    this.backoff = new ExponentialBackoff({
      baseDelay: this.options.reconnectDelay,
      maxDelay: 60000,
      maxAttempts: this.options.maxReconnectAttempts,
      jitter: 0.2,
    });
  }

  /**
   * Connect to the Lavalink node
   */
  public async connect(clientId: string): Promise<void> {
    if (this.state !== NodeState.DISCONNECTED && this.state !== NodeState.RECONNECTING) {
      throw new Error(`Cannot connect when state is ${this.state}`);
    }

    this.state = NodeState.CONNECTING;
    this.clientId = clientId;

    const protocol = this.options.secure ? 'wss' : 'ws';
    const url = `${protocol}://${this.options.host}:${this.options.port}/v4/websocket`;

    this.ws = new WebSocket(url, {
      headers: {
        'Authorization': this.options.password,
        'User-Id': clientId,
        'Client-Name': 'lavaflow/1.0.0',
        'Resume-Key': this.options.resumeKey,
      },
    });

    this.ws.on('open', this.onOpen.bind(this));
    this.ws.on('message', this.onMessage.bind(this));
    this.ws.on('close', this.onClose.bind(this));
    this.ws.on('error', this.onError.bind(this));

    // Wait for connection or timeout
    await this.waitForConnection(10000);
  }

  /**
   * Disconnect from the Lavalink node
   */
  public disconnect(): void {
    this.state = NodeState.DISCONNECTED;
    this.clearReconnectTimeout();
    this.clearHeartbeatInterval();

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, 'Normal closure');
      this.ws = null;
    }
  }

  /**
   * Register event handlers
   */
  public on<K extends keyof NodeEventHandlers>(
    event: K,
    handler: NodeEventHandlers[K]
  ): void {
    this.eventHandlers[event] = handler;
  }

  // ==================== REST API Methods ====================

  /**
   * Load tracks from a search query or URL
   */
  public async loadTracks(identifier: string): Promise<LoadResult> {
    const encodedIdentifier = encodeURIComponent(identifier);
    const endpoint = `/v4/loadtracks?identifier=${encodedIdentifier}`;

    const maxAttempts = this.options.retryStrategy === 'none' ? 1 : 3;
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        return await this.http.get<LoadResult>(endpoint);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.shouldRetryLoadError(lastError) || attempt >= maxAttempts) {
          throw lastError;
        }

        await this.delay(this.getLoadRetryDelay(attempt));
      }
    }

    throw lastError ?? new Error('Unknown loadTracks error');
  }

  /**
   * Decode a single track
   */
  public async decodeTrack(encoded: string): Promise<any> {
    const encodedTrack = encodeURIComponent(encoded);
    return this.http.get(`/v4/decodetrack?encodedTrack=${encodedTrack}`);
  }

  /**
   * Decode multiple tracks
   */
  public async decodeTracks(encoded: string[]): Promise<any[]> {
    return this.http.post('/v4/decodetracks', encoded);
  }

  /**
   * Get player information
   */
  public async getPlayer(guildId: string): Promise<PlayerResponse> {
    const sessionId = this.requireSessionId();
    return this.http.get<PlayerResponse>(`/v4/sessions/${sessionId}/players/${guildId}`);
  }

  /**
   * Update a player (v4 consolidated endpoint)
   */
  public async updatePlayer(
    guildId: string,
    payload: UpdatePlayerPayload,
    noReplace: boolean = false
  ): Promise<PlayerResponse> {
    const sessionId = this.requireSessionId();
    const normalizedPayload: UpdatePlayerPayload = { ...payload };

    if (!normalizedPayload.track && (payload.encodedTrack !== undefined || payload.identifier !== undefined)) {
      normalizedPayload.track = {
        encoded: payload.encodedTrack,
        identifier: payload.identifier,
      };
      delete normalizedPayload.encodedTrack;
      delete normalizedPayload.identifier;
    }

    const query = noReplace ? '?noReplace=true' : '';
    return this.http.patch<PlayerResponse>(
      `/v4/sessions/${sessionId}/players/${guildId}${query}`,
      normalizedPayload
    );
  }

  /**
   * Destroy a player
   */
  public async destroyPlayer(guildId: string): Promise<void> {
    const sessionId = this.requireSessionId();
    await this.http.delete(`/v4/sessions/${sessionId}/players/${guildId}`);
  }

  /**
   * Get node info
   */
  public async getInfo(): Promise<NodeInfo> {
    if (!this.info) {
      this.info = await this.http.get<NodeInfo>('/v4/info');
    }
    return this.info;
  }

  /**
   * Get node stats
   */
  public async getStats(): Promise<NodeStats> {
    return this.http.get<NodeStats>('/v4/stats');
  }

  /**
   * Get Lavalink version string
   */
  public async getVersion(): Promise<string> {
    return this.http.get<string>('/version');
  }

  /**
   * Get all players for current session
   */
  public async getSessionPlayers(): Promise<PlayerResponse[]> {
    const sessionId = this.requireSessionId();
    return this.http.get<PlayerResponse[]>(`/v4/sessions/${sessionId}/players`);
  }

  /**
   * Update session with resume capability
   */
  public async updateSession(resuming: boolean, timeout: number): Promise<void> {
    const sessionId = this.requireSessionId();
    await this.http.patch(`/v4/sessions/${sessionId}`, {
      resuming,
      timeout,
    });
  }

  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new Error(`Node ${this.options.name} is not ready: missing Lavalink session ID`);
    }

    return this.sessionId;
  }

  private shouldRetryLoadError(error: Error): boolean {
    const message = error.message.toLowerCase();

    return (
      message.includes('http 429') ||
      message.includes('http 500') ||
      message.includes('http 502') ||
      message.includes('http 503') ||
      message.includes('http 504') ||
      message.includes('fetch') ||
      message.includes('network') ||
      message.includes('timeout')
    );
  }

  private getLoadRetryDelay(attempt: number): number {
    switch (this.options.retryStrategy) {
      case 'none':
        return 0;
      case 'linear':
        return Math.min(2000, 300 * attempt);
      case 'exponential':
      default:
        return Math.min(3000, 200 * (2 ** (attempt - 1)));
    }
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  // ==================== WebSocket Event Handlers ====================

  private onOpen(): void {
    this.state = NodeState.CONNECTED;
    this.backoff.reset();
    this.lastHeartbeat = Date.now();
    this.startHeartbeat();
    this.eventHandlers.onConnect?.();
  }

  private onMessage(data: WebSocket.Data): void {
    try {
      const payload = JSON.parse(data.toString()) as LavalinkEvent;
      this.handleLavalinkEvent(payload);
    } catch (error) {
      this.eventHandlers.onError?.(
        error instanceof Error ? error : new Error('Failed to parse message')
      );
    }
  }

  private onClose(code: number, reason: Buffer): void {
    this.state = NodeState.DISCONNECTED;
    this.clearHeartbeatInterval();
    this.recordDisconnect();

    const reasonString = reason.toString();
    this.eventHandlers.onDisconnect?.(code, reasonString);

    // Attempt reconnection if not a normal closure
    if (code !== 1000 && this.options.maxReconnectAttempts !== 0) {
      this.scheduleReconnect();
    }
  }

  private onError(error: Error): void {
    this.eventHandlers.onError?.(error);
  }

  private handleLavalinkEvent(event: LavalinkEvent): void {
    switch (event.op) {
      case 'ready':
        this.handleReadyEvent(event);
        break;
      case 'playerUpdate':
        this.handlePlayerUpdateEvent(event);
        break;
      case 'stats':
        this.handleStatsEvent(event);
        break;
      case 'event':
        this.handleTrackEvent(event);
        break;
    }
  }

  private handleReadyEvent(event: ReadyEvent): void {
    this.sessionId = event.sessionId;
    this.eventHandlers.onReady?.(event.sessionId, event.resumed);

    // Configure session resuming
    if (!event.resumed) {
      this.updateSession(true, this.options.resumeTimeout).catch((error) => {
        this.eventHandlers.onError?.(error);
      });
    }
  }

  private handlePlayerUpdateEvent(event: PlayerUpdateEvent): void {
    this.lastHeartbeat = Date.now();
    this.eventHandlers.onPlayerUpdate?.(event.guildId, event.state);
  }

  private handleStatsEvent(event: StatsEvent): void {
    this.stats = {
      players: event.players,
      playingPlayers: event.playingPlayers,
      uptime: event.uptime,
      memory: event.memory,
      cpu: event.cpu,
      frameStats: event.frameStats,
    };
    this.eventHandlers.onStats?.(this.stats);
  }

  private handleTrackEvent(
    event:
      | TrackStartEvent
      | TrackEndEvent
      | TrackExceptionEvent
      | TrackStuckEvent
      | WebSocketClosedEvent
  ): void {
    switch (event.type) {
      case 'TrackStartEvent':
        this.eventHandlers.onTrackStart?.(event);
        break;
      case 'TrackEndEvent':
        this.eventHandlers.onTrackEnd?.(event);
        break;
      case 'TrackExceptionEvent':
        this.eventHandlers.onTrackException?.(event);
        break;
      case 'TrackStuckEvent':
        this.eventHandlers.onTrackStuck?.(event);
        break;
      case 'WebSocketClosedEvent':
        this.eventHandlers.onWebSocketClosed?.(event);
        break;
    }
  }

  // ==================== Connection Management ====================

  private async waitForConnection(timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, timeout);

      const checkConnection = () => {
        if (this.state === NodeState.CONNECTED) {
          clearTimeout(timer);
          resolve();
        } else if (this.state === NodeState.DISCONNECTED) {
          clearTimeout(timer);
          reject(new Error('Connection failed'));
        } else {
          setTimeout(checkConnection, 100);
        }
      };

      checkConnection();
    });
  }

  private scheduleReconnect(): void {
    if (this.backoff.hasReachedMaxAttempts()) {
      this.eventHandlers.onError?.(new Error('Max reconnection attempts reached'));
      return;
    }

    this.state = NodeState.RECONNECTING;
    const delay = this.backoff.next();
    const attempt = this.backoff.getAttempt();

    this.eventHandlers.onReconnecting?.(attempt);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (!this.clientId) {
      this.eventHandlers.onError?.(new Error('Cannot reconnect without client ID'));
      return;
    }

    try {
      await this.connect(this.clientId);
    } catch (error) {
      this.eventHandlers.onError?.(
        error instanceof Error ? error : new Error('Reconnection failed')
      );
      this.scheduleReconnect();
    }
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  // ==================== Heartbeat ====================

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastHeartbeat = now - this.lastHeartbeat;

      // If no heartbeat received in 60 seconds, consider connection dead
      if (timeSinceLastHeartbeat > 60000) {
        this.eventHandlers.onError?.(new Error('Heartbeat timeout'));
        this.ws?.close(4000, 'Heartbeat timeout');
      }
    }, 15000);
  }

  private clearHeartbeatInterval(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // ==================== Utility Methods ====================

  /**
   * Check if node is connected
   */
  public isConnected(): boolean {
    return this.state === NodeState.CONNECTED && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get node penalty for load balancing
   */
  public getPenalty(): number {
    if (!this.isConnected() || !this.stats) {
      return Infinity;
    }

    let penalty = 0;

    // Player penalties
    penalty += this.stats.players;
    penalty += this.stats.playingPlayers * 2;

    // CPU penalty (normalized by core count)
    if (this.stats.cpu.cores > 0) {
      const cpuPenalty = (this.stats.cpu.lavalinkLoad / this.stats.cpu.cores) * 100;
      penalty += cpuPenalty;
    }

    // Memory penalty (if using more than 80% of allocated memory)
    const memoryUsageRatio = this.stats.memory.used / this.stats.memory.allocated;
    if (memoryUsageRatio > 0.8) {
      penalty += (memoryUsageRatio - 0.8) * 500;
    }

    // Frame penalties (if available)
    if (this.stats.frameStats) {
      penalty += this.stats.frameStats.deficit * 2;
      penalty += this.stats.frameStats.nulled;
    }

    return penalty;
  }

  /**
   * Get detailed penalty breakdown
   */
  public getPenaltyDetails(): {
    total: number;
    players: number;
    playingPlayers: number;
    cpu: number;
    memory: number;
    frames: number;
  } {
    if (!this.isConnected() || !this.stats) {
      return {
        total: Infinity,
        players: 0,
        playingPlayers: 0,
        cpu: 0,
        memory: 0,
        frames: 0,
      };
    }

    const playersPenalty = this.stats.players;
    const playingPlayersPenalty = this.stats.playingPlayers * 2;
    const cpuPenalty =
      this.stats.cpu.cores > 0
        ? (this.stats.cpu.lavalinkLoad / this.stats.cpu.cores) * 100
        : 0;

    const memoryUsageRatio = this.stats.memory.used / this.stats.memory.allocated;
    const memoryPenalty = memoryUsageRatio > 0.8 ? (memoryUsageRatio - 0.8) * 500 : 0;

    const framesPenalty = this.stats.frameStats
      ? this.stats.frameStats.deficit * 2 + this.stats.frameStats.nulled
      : 0;

    const total =
      playersPenalty + playingPlayersPenalty + cpuPenalty + memoryPenalty + framesPenalty;

    return {
      total,
      players: playersPenalty,
      playingPlayers: playingPlayersPenalty,
      cpu: cpuPenalty,
      memory: memoryPenalty,
      frames: framesPenalty,
    };
  }

  /**
   * Get node metrics (uptime, disconnect count, etc.)
   */
  public getMetrics(): {
    name: string;
    uptime: number;
    isConnected: boolean;
    lastDisconnect: number | null;
    disconnectCount: number;
    sessionId: string | null;
    players: number;
    playingPlayers: number;
  } {
    return {
      name: this.options.name,
      uptime: Date.now() - this.createdAt,
      isConnected: this.state === NodeState.CONNECTED,
      lastDisconnect: this.lastDisconnect,
      disconnectCount: this.disconnectCount,
      sessionId: this.sessionId,
      players: this.stats?.players ?? 0,
      playingPlayers: this.stats?.playingPlayers ?? 0,
    };
  }

  /**
   * Track a disconnect event (internal use)
   */
  public recordDisconnect(): void {
    this.lastDisconnect = Date.now();
    this.disconnectCount++;
  }
}
