import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Raya } from '../Raya';
import type { Player } from '../player/Player';
import type { LoopMode, RayaPlugin } from '../types/raya';

/** How a server appears publicly. */
export interface LiveServerInfo {
  name: string;
  /** Image URL for the server icon */
  icon?: string | null;
}

export interface NowPlayingFeedOptions {
  /**
   * Opt-in: return how a server should appear, or `null`/`undefined` to keep it private.
   * Called often, so keep it fast (e.g. read from your Discord client's cache).
   */
  publish: (guildId: string) => LiveServerInfo | null | undefined;
  /** Start a standalone HTTP server on this port. Omit it to mount `feed.handle` on your own server. */
  port?: number;
  /** Interface to bind the standalone server to. Default: all interfaces */
  host?: string;
  /** URL path. The JSON snapshot is served at `path` and the live stream at `path/stream`. Default: '/now-playing' */
  path?: string;
  /** Access-Control-Allow-Origin, e.g. your website origin. Default: '*' */
  cors?: string;
  /** How often to check for pauses, seeks and drift, in ms. Default: 2000 */
  interval?: number;
  /** Maximum simultaneous stream connections. Default: 500 */
  maxClients?: number;
  /** Include how many servers are playing in total (public or not, as a number only). Default: true */
  includeTotals?: boolean;
}

export interface LiveTrack {
  title: string;
  author: string;
  uri: string | null;
  artworkUrl: string | null;
  source: string;
  /** ms */
  duration: number;
  isStream: boolean;
}

export interface LivePlayer {
  id: string;
  server: { name: string; icon: string | null };
  track: LiveTrack;
  /** Position in ms when the snapshot was taken */
  position: number;
  paused: boolean;
  /** Playback speed multiplier (timescale filters) */
  speed: number;
  loop: LoopMode;
  queueSize: number;
}

export interface LiveSnapshot {
  players: LivePlayer[];
  totals: { playing: number } | null;
  /** Server time in ms when the snapshot was taken */
  time: number;
}

const MAX_TEXT = 200;
const clip = (value: unknown) => String(value ?? '').slice(0, MAX_TEXT);
const httpUrl = (value: unknown) => (typeof value === 'string' && /^https?:\/\//i.test(value) ? value.slice(0, 1000) : null);

/**
 * Publishes what your bot is playing, in real time, for servers that opted in.
 *
 * - `GET /now-playing` returns a JSON snapshot.
 * - `GET /now-playing/stream` is a Server-Sent Events stream that pushes a snapshot on every change.
 *
 * No usernames or requesters are ever included.
 */
export class NowPlayingFeed implements RayaPlugin {
  public readonly name = 'now-playing-feed';

  private raya: Raya | null = null;
  private server: http.Server | null = null;
  private readonly clients = new Set<http.ServerResponse>();
  private readonly options: Required<Omit<NowPlayingFeedOptions, 'port' | 'host'>> & Pick<NowPlayingFeedOptions, 'port' | 'host'>;
  private last: LiveSnapshot = { players: [], totals: null, time: 0 };
  private lastKey = '';
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(options: NowPlayingFeedOptions) {
    if (typeof options?.publish !== 'function') {
      throw new TypeError('NowPlayingFeed needs a publish(guildId) function to decide which servers are public');
    }
    this.options = {
      publish: options.publish,
      port: options.port,
      host: options.host,
      path: `/${(options.path ?? '/now-playing').replace(/^\/+|\/+$/g, '')}`,
      cors: options.cors ?? '*',
      interval: options.interval ?? 2000,
      maxClients: options.maxClients ?? 500,
      includeTotals: options.includeTotals ?? true,
    };
  }

  /** Number of connected stream clients */
  public get connections(): number {
    return this.clients.size;
  }

  /** The feed URL of the standalone server, once listening. */
  public get url(): string | null {
    const address = this.server?.address() as AddressInfo | null;
    if (!address) return null;
    const host = !this.options.host || this.options.host === '0.0.0.0' || this.options.host === '::' ? 'localhost' : this.options.host;
    return `http://${host}:${address.port}${this.options.path}`;
  }

  public async load(raya: Raya): Promise<void> {
    this.raya = raya;
    for (const event of ['trackStart', 'queueEnd', 'playerDestroy', 'playerResume', 'queueUpdate', 'playerMove'] as const) {
      raya.on(event, this.scheduleSync);
    }
    this.pollTimer = setInterval(() => this.sync(), this.options.interval);
    this.pollTimer.unref();
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) client.write(': ping\n\n');
    }, 25000);
    this.heartbeatTimer.unref();
    if (this.options.port !== undefined) await this.listen(this.options.port, this.options.host);
  }

  public async unload(raya: Raya): Promise<void> {
    for (const event of ['trackStart', 'queueEnd', 'playerDestroy', 'playerResume', 'queueUpdate', 'playerMove'] as const) {
      raya.off(event, this.scheduleSync);
    }
    for (const timer of [this.pollTimer, this.heartbeatTimer, this.syncTimer]) if (timer) clearInterval(timer);
    this.pollTimer = this.heartbeatTimer = this.syncTimer = null;
    for (const client of this.clients) client.end();
    this.clients.clear();
    if (this.server) {
      const server = this.server;
      this.server = null;
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.raya = null;
  }

  /** Start a standalone HTTP server (called automatically when `port` is set). */
  public listen(port: number, host?: string): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = http.createServer((req, res) => {
      if (!this.handle(req, res)) {
        res.writeHead(404, this.corsHeaders({ 'Content-Type': 'application/json' }));
        res.end('{"error":"Not found"}');
      }
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        this.raya?.debug(() => `[NowPlayingFeed] listening on ${this.url}`);
        resolve();
      });
    });
  }

  /**
   * Handle a request on your own HTTP server (Express, Fastify's raw handler, ...).
   * Returns false when the URL is not a feed route, so you can pass it on.
   */
  public handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    const base = this.options.path;
    if (pathname !== base && pathname !== `${base}/stream`) return false;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, this.corsHeaders({ 'Access-Control-Allow-Methods': 'GET, OPTIONS' }));
      res.end();
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, this.corsHeaders({ Allow: 'GET, OPTIONS' }));
      res.end();
      return true;
    }

    if (pathname === base) {
      res.writeHead(200, this.corsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }));
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(this.snapshot()));
      return true;
    }

    if (this.clients.size >= this.options.maxClients) {
      res.writeHead(503, this.corsHeaders({ 'Retry-After': '30' }));
      res.end();
      return true;
    }
    res.writeHead(200, this.corsHeaders({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }));
    res.write('retry: 3000\n\n');
    res.write(this.format(this.snapshot()));
    this.clients.add(res);
    const remove = () => this.clients.delete(res);
    req.on('close', remove);
    res.on('error', remove);
    return true;
  }

  /** Build a fresh snapshot of public players. */
  public snapshot(): LiveSnapshot {
    const players: LivePlayer[] = [];
    let playing = 0;
    for (const player of this.raya?.players.values() ?? []) {
      if (player.destroyed || !player.current) continue;
      if (!player.paused) playing++;
      const entry = this.describe(player);
      if (entry) players.push(entry);
    }
    players.sort((a, b) => a.server.name.localeCompare(b.server.name) || a.id.localeCompare(b.id));
    return { players, totals: this.options.includeTotals ? { playing } : null, time: Date.now() };
  }

  /** Push the current state to every client immediately. */
  public refresh(): void {
    this.sync(true);
  }

  private describe(player: Player): LivePlayer | null {
    let info: LiveServerInfo | null | undefined;
    try {
      info = this.options.publish(player.guildId);
    } catch (error) {
      this.raya?.debug(() => `[NowPlayingFeed] publish(${player.guildId}) threw: ${String(error)}`);
      return null;
    }
    if (!info || !info.name) return null;
    const track = player.current!;
    return {
      id: player.guildId,
      server: { name: clip(info.name), icon: httpUrl(info.icon) },
      track: {
        title: clip(track.info.title),
        author: clip(track.info.author),
        uri: httpUrl(track.info.uri),
        artworkUrl: httpUrl(track.info.artworkUrl),
        source: clip(track.info.sourceName),
        duration: track.info.length,
        isStream: track.info.isStream,
      },
      position: player.position,
      paused: player.paused,
      speed: player.filters.speedMultiplier,
      loop: player.loop,
      queueSize: player.queue.size,
    };
  }

  private readonly scheduleSync = (): void => {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.sync();
    }, 150);
    this.syncTimer.unref();
  };

  private sync(force = false): void {
    if (!this.raya) return;
    const next = this.snapshot();
    const key = JSON.stringify([
      next.totals,
      next.players.map((p) => [p.id, p.server, p.track.title, p.track.uri, p.paused, p.speed, p.loop, p.queueSize]),
    ]);
    let changed = force || key !== this.lastKey;
    if (!changed) {
      // Seeks and drift: compare with where the previous snapshot says each track should be now.
      const previous = new Map(this.last.players.map((p) => [p.id, p]));
      changed = next.players.some((p) => {
        const before = previous.get(p.id);
        if (!before) return true;
        const expected = before.paused ? before.position : before.position + (next.time - this.last.time) * before.speed;
        return Math.abs(Math.min(expected, p.track.duration) - p.position) > 2000;
      });
    }
    if (!changed) return;
    this.last = next;
    this.lastKey = key;
    if (this.clients.size === 0) return;
    const message = this.format(next);
    for (const client of this.clients) client.write(message);
  }

  private format(snapshot: LiveSnapshot): string {
    return `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  }

  private corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { 'Access-Control-Allow-Origin': this.options.cors, Vary: 'Origin', ...extra };
  }
}
