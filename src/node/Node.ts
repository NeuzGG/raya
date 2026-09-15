import WebSocket from 'ws';
import { Rest } from './Rest';
import type { Raya } from '../Raya';
import type { Player } from '../player/Player';
import type { IncomingMessage, NodeInfo, NodeStats } from '../types/lavalink';
import type { NodeOptions, ResolvedNodeOptions } from '../types/raya';
import { RayaError } from '../utils/errors';
import { backoffDelay } from '../utils/backoff';

export enum NodeState {
  Idle = 'idle',
  Connecting = 'connecting',
  Ready = 'ready',
  Reconnecting = 'reconnecting',
  Disconnected = 'disconnected',
  Destroyed = 'destroyed',
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export function resolveNodeOptions(options: NodeOptions): ResolvedNodeOptions {
  if (!options || typeof options.host !== 'string' || !options.host) {
    throw new RayaError('INVALID_ARGUMENT', 'Node option "host" is required');
  }
  if (typeof options.password !== 'string') {
    throw new RayaError('INVALID_ARGUMENT', `Node "${options.name ?? options.host}" requires a "password"`);
  }
  const secure = options.secure ?? false;
  const port = options.port ?? (secure ? 443 : 2333);
  return {
    name: options.name ?? `${options.host}:${port}`,
    host: options.host,
    port,
    password: options.password,
    secure,
    regions: (options.regions ?? []).map((r) => r.toLowerCase()),
    retry: {
      maxAttempts: options.retry?.maxAttempts ?? Infinity,
      baseDelay: options.retry?.baseDelay ?? 1000,
      maxDelay: options.retry?.maxDelay ?? 30000,
    },
    requestTimeout: options.requestTimeout ?? 10000,
    resumeTimeout: options.resumeTimeout ?? 60,
    pingInterval: options.pingInterval ?? 20000,
    sessionId: options.sessionId ?? null,
  };
}

/**
 * A single Lavalink v4 node: WebSocket session, REST client, stats and load penalty.
 */
export class Node {
  public readonly options: ResolvedNodeOptions;
  public readonly rest: Rest;
  /** Players currently assigned to this node */
  public readonly players = new Set<Player>();

  public state: NodeState = NodeState.Idle;
  public sessionId: string | null;
  public stats: NodeStats | null = null;
  public info: NodeInfo | null = null;
  /** WebSocket round-trip latency in ms, -1 until measured */
  public ping = -1;
  /** Consecutive reconnect attempts since the last ready */
  public reconnectAttempts = 0;
  public connectedAt: number | null = null;

  private ws: WebSocket | null = null;
  private readyWaiter: Waiter | null = null;
  private pending: Promise<void> | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingSentAt = 0;
  private awaitingPong = false;
  private manualClose = false;
  private authFailed = false;
  private lastError: Error | null = null;

  constructor(
    private readonly raya: Raya,
    options: NodeOptions,
  ) {
    this.options = resolveNodeOptions(options);
    this.sessionId = this.options.sessionId;
    this.rest = new Rest(this, raya.clientName);
  }

  public get name(): string {
    return this.options.name;
  }

  /** True when the node has a ready Lavalink session. */
  public get connected(): boolean {
    return this.state === NodeState.Ready;
  }

  /** Server uptime in ms from the latest stats */
  public get uptime(): number {
    return this.stats?.uptime ?? 0;
  }

  /**
   * Lower is better. Based on Lavalink's own load balancer formula, plus players assigned
   * locally since the last stats frame so bursts of new players spread across nodes.
   */
  public get penalty(): number {
    if (!this.connected) return Infinity;
    const stats = this.stats;
    let penalty = Math.max(this.players.size, stats?.playingPlayers ?? 0);
    if (stats) {
      penalty += Math.round(1.05 ** (100 * stats.cpu.systemLoad) * 10 - 10);
      if (stats.frameStats) {
        penalty += Math.round(1.03 ** (500 * (stats.frameStats.deficit / 3000)) * 600 - 600);
        penalty += Math.round((1.03 ** (500 * (stats.frameStats.nulled / 3000)) * 300 - 300) * 2);
      }
    }
    return penalty;
  }

  public hasPlugin(name: string): boolean {
    return this.info?.plugins.some((p) => p.name.toLowerCase() === name.toLowerCase()) ?? false;
  }

  public hasSource(name: string): boolean {
    return this.info?.sourceManagers.some((s) => s.toLowerCase() === name.toLowerCase()) ?? false;
  }

  public hasFilter(name: string): boolean {
    return this.info?.filters.some((f) => f.toLowerCase() === name.toLowerCase()) ?? false;
  }

  public matchesRegion(region: string | undefined): boolean {
    if (!region || this.options.regions.length === 0) return false;
    const r = region.toLowerCase();
    return this.options.regions.some((own) => r === own || r.startsWith(own) || own.startsWith(r));
  }

  // ==================== Lifecycle ====================

  /**
   * Connect and resolve once Lavalink sends `ready`. If this attempt fails the node keeps
   * reconnecting in the background according to its retry options.
   */
  public connect(): Promise<void> {
    if (this.state === NodeState.Destroyed) {
      return Promise.reject(new RayaError('NODE_NOT_READY', `Node "${this.name}" was destroyed`));
    }
    if (this.state === NodeState.Ready) return Promise.resolve();
    if (this.pending) return this.pending;
    this.manualClose = false;
    this.authFailed = false;
    this.clearReconnectTimer();
    this.pending = this.open().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /**
   * Close the connection without reconnecting. Lavalink keeps the session (and its players)
   * alive for `resumeTimeout` seconds, so a later `connect()` resumes seamlessly.
   */
  public disconnect(code = 1000, reason = 'Disconnected by client'): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    const ws = this.ws;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
      else ws.terminate();
    } else if (this.state !== NodeState.Destroyed) {
      this.state = NodeState.Disconnected;
    }
  }

  /** Permanently close this node. */
  public destroy(): void {
    this.disconnect(1000, 'Node destroyed');
    this.state = NodeState.Destroyed;
    this.readyWaiter?.reject(new RayaError('NODE_NOT_READY', `Node "${this.name}" was destroyed`));
    this.readyWaiter = null;
  }

  private open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
      this.state = this.reconnectAttempts > 0 ? NodeState.Reconnecting : NodeState.Connecting;
      this.lastError = null;

      const url = `${this.options.secure ? 'wss' : 'ws'}://${this.options.host}:${this.options.port}/v4/websocket`;
      const headers: Record<string, string> = {
        Authorization: this.options.password,
        'User-Id': this.raya.requireUserId(),
        'Client-Name': this.raya.clientName,
      };
      if (this.sessionId && this.options.resumeTimeout > 0) headers['Session-Id'] = this.sessionId;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url, { headers, handshakeTimeout: this.options.requestTimeout });
      } catch (error) {
        this.readyWaiter = null;
        this.state = NodeState.Disconnected;
        reject(new RayaError('INVALID_ARGUMENT', `Invalid node URL for "${this.name}"`, { cause: error }));
        return;
      }
      this.ws = ws;
      this.raya.debug(() => `[Node ${this.name}] connecting to ${url}${headers['Session-Id'] ? ' (resuming)' : ''}`);

      ws.on('open', () => this.onOpen(ws));
      ws.on('message', (data) => this.onMessage(data));
      ws.on('pong', () => this.onPong());
      ws.on('error', (error) => this.onError(error));
      ws.on('close', (code, reason) => this.onClose(ws, code, reason.toString()));
    });
  }

  private onOpen(ws: WebSocket): void {
    if (ws !== this.ws) return;
    this.connectedAt = Date.now();
    this.startPing();
  }

  private onError(error: Error): void {
    this.lastError = error;
    const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1];
    if (status === '401' || status === '403') this.authFailed = true;
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return;
    ws.removeAllListeners();
    ws.on('error', () => undefined);
    this.ws = null;
    this.stopPing();
    this.ping = -1;
    this.connectedAt = null;

    const wasReady = this.state === NodeState.Ready;
    if (this.state !== NodeState.Destroyed) this.state = NodeState.Disconnected;
    const detail = reason || this.lastError?.message || 'connection closed';
    this.raya.debug(() => `[Node ${this.name}] disconnected (code ${code}: ${detail})`);

    if (this.readyWaiter) {
      const error = this.authFailed
        ? new RayaError('NODE_AUTH_FAILED', `Node "${this.name}" rejected the password`)
        : new RayaError('NETWORK_ERROR', `Node "${this.name}" connection failed: ${detail}`, { cause: this.lastError });
      this.readyWaiter.reject(error);
      this.readyWaiter = null;
    }

    this.raya._onNodeDisconnect(this, { code, reason: detail, wasReady });

    if (this.manualClose || this.state === NodeState.Destroyed) return;
    if (this.authFailed) {
      this.raya._onNodeError(this, new RayaError('NODE_AUTH_FAILED', `Node "${this.name}" rejected the password, not reconnecting`));
      this.raya._onNodeGone(this);
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const { maxAttempts, baseDelay, maxDelay } = this.options.retry;
    if (this.reconnectAttempts > maxAttempts) {
      this.raya._onNodeError(this, new RayaError('NETWORK_ERROR', `Node "${this.name}" gave up after ${maxAttempts} reconnect attempts`));
      this.raya._onNodeGone(this);
      return;
    }
    const delay = backoffDelay(this.reconnectAttempts, baseDelay, maxDelay);
    this.state = NodeState.Reconnecting;
    this.raya.debug(() => `[Node ${this.name}] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.raya.emit('nodeReconnecting', this, this.reconnectAttempts, delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose || this.state === NodeState.Destroyed) return;
      this.pending = this.open()
        .catch(() => undefined)
        .finally(() => {
          this.pending = null;
        });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ==================== Messages ====================

  private onMessage(data: WebSocket.RawData): void {
    let payload: IncomingMessage;
    try {
      payload = JSON.parse(data.toString()) as IncomingMessage;
    } catch (error) {
      this.raya._onNodeError(this, new RayaError('DECODE_FAILED', `Node "${this.name}" sent invalid JSON`, { cause: error }));
      return;
    }
    if (this.raya.listenerCount('nodeRaw') > 0) this.raya.emit('nodeRaw', this, payload);

    switch (payload.op) {
      case 'ready':
        this.onReady(payload.sessionId, payload.resumed);
        break;
      case 'stats': {
        const { op: _op, ...stats } = payload;
        this.stats = stats;
        this.raya.emit('nodeStats', this, stats);
        break;
      }
      case 'playerUpdate':
        this.raya._onPlayerUpdate(this, payload);
        break;
      case 'event':
        this.raya._onNodeEvent(this, payload);
        break;
    }
  }

  private onReady(sessionId: string, resumed: boolean): void {
    const previous = this.sessionId;
    this.sessionId = sessionId;
    this.state = NodeState.Ready;
    this.reconnectAttempts = 0;
    this.raya.debug(() => `[Node ${this.name}] ready (session ${sessionId}, resumed: ${resumed}${previous && !resumed ? `, previous session ${previous} lost` : ''})`);

    if (this.options.resumeTimeout > 0 && !resumed) {
      this.rest.updateSession({ resuming: true, timeout: this.options.resumeTimeout }).catch((error: Error) => {
        this.raya._onNodeError(this, error);
      });
    }
    this.rest.info().then(
      (info) => {
        this.info = info;
      },
      (error: Error) => this.raya.debug(() => `[Node ${this.name}] could not fetch /v4/info: ${error.message}`),
    );

    const waiter = this.readyWaiter;
    this.readyWaiter = null;
    waiter?.resolve();
    this.raya._onNodeReady(this, resumed);
  }

  // ==================== Ping ====================

  private startPing(): void {
    this.stopPing();
    this.sendPing();
    this.pingTimer = setInterval(() => {
      if (this.awaitingPong) {
        this.raya.debug(() => `[Node ${this.name}] no pong received, terminating dead connection`);
        this.lastError = new Error('Ping timeout');
        this.ws?.terminate();
        return;
      }
      this.sendPing();
    }, this.options.pingInterval);
    this.pingTimer.unref();
  }

  private sendPing(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.awaitingPong = true;
    this.pingSentAt = Date.now();
    this.ws.ping();
  }

  private onPong(): void {
    this.awaitingPong = false;
    this.ping = Date.now() - this.pingSentAt;
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.awaitingPong = false;
  }
}
