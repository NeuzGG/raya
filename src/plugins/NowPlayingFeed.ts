import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Raya } from '../Raya';
import type { Player } from '../player/Player';
import type { LoopMode, RayaPlugin } from '../types/raya';

/** How your bot appears on the website. */
export interface LiveBotInfo {
  /** Default: 'Raya' */
  name?: string | null;
  /** Avatar image URL, e.g. `client.user.displayAvatarURL()` */
  avatar?: string | null;
  /** Optional link, e.g. your bot invite URL */
  url?: string | null;
}

/** How a server appears publicly (per-server cards). */
export interface LiveServerInfo {
  name: string;
  /** Image URL for the server icon */
  icon?: string | null;
}

export interface NowPlayingFeedOptions {
  /**
   * Your bot. Pass an object, or a function so the latest name and avatar are always used.
   * When set, the feed includes what the bot is playing right now, without any server information.
   */
  bot?: LiveBotInfo | (() => LiveBotInfo | null | undefined);
  /**
   * Which servers may supply the bot's "now playing" track. Default: every server.
   * The track is always shared without the server's name or id.
   */
  nowPlaying?: boolean | ((guildId: string) => boolean);
  /**
   * Optional per-server cards. Return how a server should appear, or `null`/`undefined` to keep it private.
   * Called often, so keep it fast (e.g. read from your Discord client's cache).
   */
  publish?: (guildId: string) => LiveServerInfo | null | undefined;
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
  /** Include how many servers are playing in total (a number only). Default: true */
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

/** The bot's current track, shared without any server information. */
export interface LiveNowPlaying {
  track: LiveTrack;
  /** Position in ms when the snapshot was taken */
  position: number;
  paused: boolean;
  /** Playback speed multiplier (timescale filters) */
  speed: number;
}

export interface LivePlayer extends LiveNowPlaying {
  id: string;
  server: { name: string; icon: string | null };
  loop: LoopMode;
  queueSize: number;
}

export interface LiveSnapshot {
  bot: { name: string; avatar: string | null; url: string | null; uptime: number } | null;
  nowPlaying: LiveNowPlaying | null;
  players: LivePlayer[];
  totals: { playing: number } | null;
  /** Server time in ms when the snapshot was taken */
  time: number;
}

type ResolvedOptions = Required<Pick<NowPlayingFeedOptions, 'path' | 'cors' | 'interval' | 'maxClients' | 'includeTotals'>> &
  Pick<NowPlayingFeedOptions, 'bot' | 'publish' | 'port' | 'host'> & { nowPlaying: (guildId: string) => boolean };

const MAX_TEXT = 200;
const EVENTS = ['queueEnd', 'playerResume', 'queueUpdate', 'playerMove'] as const;
const clip = (value: unknown) => String(value ?? '').slice(0, MAX_TEXT);
const httpUrl = (value: unknown) => (typeof value === 'string' && /^https?:\/\//i.test(value) ? value.slice(0, 1000) : null);

/**
 * Publishes what your bot is playing, in real time.
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
  private readonly options: ResolvedOptions;
  private readonly startedAt = new Map<string, number>();
  private featuredGuild: string | null = null;
  private last: LiveSnapshot = { bot: null, nowPlaying: null, players: [], totals: null, time: 0 };
  private lastKey = '';
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(options: NowPlayingFeedOptions) {
    if (!options || (options.bot === undefined && typeof options.publish !== 'function')) {
      throw new TypeError('NowPlayingFeed needs `bot` (to show your bot) and/or `publish` (to show servers)');
    }
    if (options.publish !== undefined && typeof options.publish !== 'function') {
      throw new TypeError('NowPlayingFeed `publish` must be a function');
    }
    const share = options.nowPlaying ?? options.bot !== undefined;
    this.options = {
      bot: options.bot,
      publish: options.publish,
      nowPlaying: typeof share === 'function' ? share : () => share,
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
    raya.on('trackStart', this.onTrackStart);
    raya.on('playerDestroy', this.onPlayerDestroy);
    for (const event of EVENTS) raya.on(event, this.scheduleSync);
    this.pollTimer = setInterval(() => this.sync(), this.options.interval);
    this.pollTimer.unref();
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) client.write(': ping\n\n');
    }, 25000);
    this.heartbeatTimer.unref();
    if (this.options.port !== undefined) await this.listen(this.options.port, this.options.host);
  }

  public async unload(raya: Raya): Promise<void> {
    raya.off('trackStart', this.onTrackStart);
    raya.off('playerDestroy', this.onPlayerDestroy);
    for (const event of EVENTS) raya.off(event, this.scheduleSync);
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

  /** Build a fresh snapshot. */
  public snapshot(): LiveSnapshot {
    const players: LivePlayer[] = [];
    const candidates: Player[] = [];
    let playing = 0;
    for (const player of this.raya?.players.values() ?? []) {
      if (player.destroyed || !player.current) continue;
      if (!player.paused) playing++;
      if (this.allowNowPlaying(player.guildId)) candidates.push(player);
      if (this.options.publish) {
        const entry = this.describe(player);
        if (entry) players.push(entry);
      }
    }
    players.sort((a, b) => a.server.name.localeCompare(b.server.name) || a.id.localeCompare(b.id));
    const featured = this.options.bot !== undefined ? this.pickFeatured(candidates) : null;
    return {
      bot: this.describeBot(),
      nowPlaying: featured ? this.live(featured) : null,
      players,
      totals: this.options.includeTotals ? { playing } : null,
      time: Date.now(),
    };
  }

  /** Push the current state to every client immediately. */
  public refresh(): void {
    this.sync(true);
  }

  private describeBot(): LiveSnapshot['bot'] {
    const source = this.options.bot;
    if (source === undefined) return null;
    let info: LiveBotInfo | null | undefined;
    try {
      info = typeof source === 'function' ? source() : source;
    } catch (error) {
      this.raya?.debug(() => `[NowPlayingFeed] bot() threw: ${String(error)}`);
      info = null;
    }
    return {
      name: clip(info?.name || 'Raya'),
      avatar: httpUrl(info?.avatar),
      url: httpUrl(info?.url),
      uptime: Math.round(process.uptime() * 1000),
    };
  }

  /** Keep showing the same server's music while it plays, otherwise the most recently started track. */
  private pickFeatured(candidates: Player[]): Player | null {
    if (candidates.length === 0) {
      this.featuredGuild = null;
      return null;
    }
    const playing = candidates.filter((player) => !player.paused);
    const sticky = playing.find((player) => player.guildId === this.featuredGuild);
    if (sticky) return sticky;
    const pool = playing.length ? playing : candidates;
    const current = pool.find((player) => player.guildId === this.featuredGuild);
    const choice = current ?? pool.reduce((best, player) =>
      (this.startedAt.get(player.guildId) ?? 0) > (this.startedAt.get(best.guildId) ?? 0) ? player : best,
    );
    this.featuredGuild = choice.guildId;
    return choice;
  }

  private allowNowPlaying(guildId: string): boolean {
    try {
      return Boolean(this.options.nowPlaying(guildId));
    } catch {
      return false;
    }
  }

  private live(player: Player): LiveNowPlaying {
    const track = player.current!;
    return {
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
    };
  }

  private describe(player: Player): LivePlayer | null {
    let info: LiveServerInfo | null | undefined;
    try {
      info = this.options.publish!(player.guildId);
    } catch (error) {
      this.raya?.debug(() => `[NowPlayingFeed] publish(${player.guildId}) threw: ${String(error)}`);
      return null;
    }
    if (!info || !info.name) return null;
    return {
      id: player.guildId,
      server: { name: clip(info.name), icon: httpUrl(info.icon) },
      ...this.live(player),
      loop: player.loop,
      queueSize: player.queue.size,
    };
  }

  private readonly onTrackStart = (player: Player): void => {
    this.startedAt.set(player.guildId, Date.now());
    this.scheduleSync();
  };

  private readonly onPlayerDestroy = (player: Player): void => {
    this.startedAt.delete(player.guildId);
    this.scheduleSync();
  };

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
    const describe = (entry: LiveNowPlaying | null) =>
      entry ? [entry.track.title, entry.track.uri, entry.track.artworkUrl, entry.paused, entry.speed] : null;
    const key = JSON.stringify([
      next.bot && [next.bot.name, next.bot.avatar, next.bot.url],
      describe(next.nowPlaying),
      next.totals,
      next.players.map((p) => [p.id, p.server, ...describe(p)!, p.loop, p.queueSize]),
    ]);

    let changed = force || key !== this.lastKey;
    if (!changed) {
      // Seeks and drift: compare with where the previous snapshot says each track should be now.
      const drifted = (before: LiveNowPlaying | null | undefined, now: LiveNowPlaying) => {
        if (!before) return true;
        const expected = before.paused ? before.position : before.position + (next.time - this.last.time) * before.speed;
        return Math.abs(Math.min(expected, now.track.duration) - now.position) > 2000;
      };
      const previous = new Map(this.last.players.map((p) => [p.id, p]));
      changed =
        (next.nowPlaying !== null && drifted(this.last.nowPlaying, next.nowPlaying)) ||
        next.players.some((p) => drifted(previous.get(p.id), p));
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
