import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { decodeTrack, encodeTrack } from '../../src/utils/TrackCodec';
import type { FilterOptions, LavalinkTrack, LoadResult, VoiceState } from '../../src/types/lavalink';

export interface MockPlayer {
  guildId: string;
  track: LavalinkTrack | null;
  volume: number;
  paused: boolean;
  position: number;
  endTime: number | null;
  filters: FilterOptions;
  voice: Partial<VoiceState>;
}

interface Session {
  id: string;
  ws: WebSocket | null;
  resuming: boolean;
  timeout: number;
  players: Map<string, MockPlayer>;
  expiry: NodeJS.Timeout | null;
}

export interface LoggedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

export interface UpgradeInfo {
  headers: http.IncomingHttpHeaders;
  resumed: boolean;
}

export function makeTrack(title: string, overrides: Partial<LavalinkTrack['info']> = {}): LavalinkTrack {
  const info = {
    title,
    author: overrides.author ?? 'Mock Artist',
    length: overrides.length ?? 180000,
    identifier: overrides.identifier ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    isStream: overrides.isStream ?? false,
    uri: overrides.uri ?? `https://www.youtube.com/watch?v=${overrides.identifier ?? title}`,
    artworkUrl: overrides.artworkUrl ?? null,
    isrc: overrides.isrc ?? null,
    sourceName: overrides.sourceName ?? 'youtube',
    position: 0,
  };
  const encoded = encodeTrack(info);
  return { encoded, info: { ...info, isSeekable: !info.isStream }, pluginInfo: {}, userData: {} };
}

/**
 * Real Lavalink re-encodes the track for every event and player state (`track.toTrack(...)`),
 * and lavaplayer's encoding includes the current position, so `encoded` changes while playing.
 */
export function atPosition(track: LavalinkTrack, position: number): LavalinkTrack {
  const info = { ...track.info, position: Math.floor(position) };
  return { ...track, info, encoded: encodeTrack(info) };
}

/**
 * In-process Lavalink v4 server implementing the WebSocket + REST surface Raya uses.
 */
export class MockLavalink {
  public readonly requests: LoggedRequest[] = [];
  public readonly upgrades: UpgradeInfo[] = [];
  public readonly sessions = new Map<string, Session>();
  public loadHandler: ((identifier: string) => LoadResult) | null = null;
  public sourceManagers = ['youtube', 'soundcloud', 'http'];
  /** Spotify recommendations only work with Extended quota mode, which most setups lack */
  public spotifyRecommendations = false;
  public port = 0;

  private server!: http.Server;
  private wss!: WebSocketServer;

  private constructor(
    public readonly password: string,
    private readonly autoPong: boolean,
  ) {}

  public static async start(options: { password?: string; port?: number; autoPong?: boolean } = {}): Promise<MockLavalink> {
    const mock = new MockLavalink(options.password ?? 'youshallnotpass', options.autoPong ?? true);
    await mock.listen(options.port ?? 0);
    return mock;
  }

  private listen(port: number): Promise<void> {
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
    this.wss = new WebSocketServer({ noServer: true, autoPong: this.autoPong });
    this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        this.port = (this.server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  /** Stop the server completely (the node becomes unreachable). */
  public async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    for (const session of this.sessions.values()) if (session.expiry) clearTimeout(session.expiry);
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Start again on the same port with no sessions (a Lavalink restart). */
  public async restartFresh(): Promise<void> {
    await this.stop();
    this.sessions.clear();
    await this.listen(this.port);
  }

  /** Kill WebSocket connections but keep resumable sessions (a network blip). */
  public dropConnections(): void {
    for (const client of this.wss.clients) client.terminate();
  }

  // ==================== Test helpers ====================

  public patches(guildId?: string): LoggedRequest[] {
    return this.requests.filter(
      (r) => r.method === 'PATCH' && r.path.includes('/players/') && (!guildId || r.path.endsWith(`/players/${guildId}`)),
    );
  }

  public count(method: string, pathIncludes: string): number {
    return this.requests.filter((r) => r.method === method && r.path.includes(pathIncludes)).length;
  }

  public player(guildId: string): MockPlayer | undefined {
    for (const session of this.sessions.values()) {
      const player = session.players.get(guildId);
      if (player) return player;
    }
    return undefined;
  }

  public finishTrack(guildId: string): void {
    this.endTrack(guildId, 'finished');
  }

  public failTrack(guildId: string): void {
    const { session, player } = this.find(guildId);
    if (!player.track) throw new Error('no track');
    this.send(session, {
      op: 'event',
      type: 'TrackExceptionEvent',
      guildId,
      track: atPosition(player.track, player.position + 1234),
      exception: { message: 'boom', severity: 'common', cause: 'test' },
    });
    this.endTrack(guildId, 'loadFailed');
  }

  public stuckTrack(guildId: string): void {
    const { session, player } = this.find(guildId);
    if (!player.track) throw new Error('no track');
    this.send(session, { op: 'event', type: 'TrackStuckEvent', guildId, track: atPosition(player.track, player.position + 1234), thresholdMs: 10000 });
  }

  public closeVoice(guildId: string, code: number): void {
    const { session } = this.find(guildId);
    this.send(session, { op: 'event', type: 'WebSocketClosedEvent', guildId, code, reason: 'test', byRemote: true });
  }

  public sendPlayerUpdate(guildId: string, position: number, connected = true): void {
    const { session } = this.find(guildId);
    this.send(session, { op: 'playerUpdate', guildId, state: { time: Date.now(), position, connected, ping: 12 } });
  }

  public sendEvent(guildId: string, event: Record<string, unknown>): void {
    const { session } = this.find(guildId);
    this.send(session, { op: 'event', guildId, ...event });
  }

  private endTrack(guildId: string, reason: string): void {
    const { session, player } = this.find(guildId);
    const track = player.track;
    if (!track) throw new Error(`no track playing in ${guildId}`);
    player.track = null;
    const position = reason === 'finished' ? track.info.length : player.position + 1234;
    this.send(session, { op: 'event', type: 'TrackEndEvent', guildId, track: atPosition(track, position), reason });
  }

  private find(guildId: string): { session: Session; player: MockPlayer } {
    for (const session of this.sessions.values()) {
      const player = session.players.get(guildId);
      if (player) return { session, player };
    }
    throw new Error(`mock has no player for ${guildId}`);
  }

  private send(session: Session, payload: unknown): void {
    session.ws?.send(JSON.stringify(payload));
  }

  // ==================== WebSocket ====================

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!req.url?.startsWith('/v4/websocket')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (req.headers.authorization !== this.password) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const requested = req.headers['session-id'] as string | undefined;
    const existing = requested ? this.sessions.get(requested) : undefined;
    const resumed = Boolean(existing && existing.resuming);
    if (resumed && existing?.ws) {
      // The client reconnected before the server noticed the old socket died.
      const stale = existing.ws;
      existing.ws = null;
      stale.terminate();
    }
    this.upgrades.push({ headers: req.headers, resumed });

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      let session: Session;
      if (resumed && existing) {
        session = existing;
        if (session.expiry) clearTimeout(session.expiry);
        session.expiry = null;
      } else {
        session = { id: randomUUID().slice(0, 16), ws: null, resuming: false, timeout: 60, players: new Map(), expiry: null };
        this.sessions.set(session.id, session);
      }
      session.ws = ws;
      ws.send(JSON.stringify({ op: 'ready', resumed, sessionId: session.id }));
      ws.send(
        JSON.stringify({
          op: 'stats',
          players: session.players.size,
          playingPlayers: session.players.size,
          uptime: 1000,
          memory: { free: 1, used: 1, allocated: 2, reservable: 4 },
          cpu: { cores: 4, systemLoad: 0.1, lavalinkLoad: 0.05 },
          frameStats: null,
        }),
      );
      ws.on('close', () => {
        if (session.ws !== ws) return;
        session.ws = null;
        if (session.resuming) {
          session.expiry = setTimeout(() => this.sessions.delete(session.id), session.timeout * 1000);
          session.expiry.unref();
        } else {
          this.sessions.delete(session.id);
        }
      });
    });
  }

  // ==================== REST ====================

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body });

    const json = (status: number, data?: unknown) => {
      if (data === undefined) {
        res.writeHead(status).end();
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    };
    const error = (status: number, message: string) =>
      json(status, { timestamp: Date.now(), status, error: 'Error', message, path: url.pathname });

    if (req.headers.authorization !== this.password) return error(401, 'Unauthorized');

    const path = url.pathname;
    if (req.method === 'GET' && path === '/version') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('4.1.1');
      return;
    }
    if (req.method === 'GET' && path === '/v4/info') {
      return json(200, {
        version: { semver: '4.1.1', major: 4, minor: 1, patch: 1, preRelease: null, build: null },
        buildTime: 0,
        git: { branch: 'main', commit: 'mock', commitTime: 0 },
        jvm: '21',
        lavaplayer: '2.2.4',
        sourceManagers: this.sourceManagers,
        filters: ['equalizer', 'timescale', 'rotation'],
        plugins: [],
      });
    }
    if (req.method === 'GET' && path === '/v4/stats') {
      return json(200, { players: 0, playingPlayers: 0, uptime: 1, memory: { free: 1, used: 1, allocated: 1, reservable: 1 }, cpu: { cores: 1, systemLoad: 0, lavalinkLoad: 0 }, frameStats: null });
    }
    if (req.method === 'GET' && path === '/v4/loadtracks') {
      return json(200, this.load(url.searchParams.get('identifier') ?? ''));
    }
    if (req.method === 'GET' && path === '/v4/decodetrack') {
      return json(200, decodeTrack(url.searchParams.get('encodedTrack') ?? ''));
    }

    const sessionMatch = /^\/v4\/sessions\/([^/]+)(?:\/players(?:\/([^/]+))?)?$/.exec(path);
    if (!sessionMatch) return error(404, 'Not found');
    const session = this.sessions.get(sessionMatch[1]!);
    if (!session) return error(404, 'Session not found');
    const guildId = sessionMatch[2];
    const isPlayers = path.includes('/players');

    if (!isPlayers && req.method === 'PATCH') {
      if (body.resuming !== undefined) session.resuming = body.resuming;
      if (body.timeout !== undefined) session.timeout = body.timeout;
      return json(200, { resuming: session.resuming, timeout: session.timeout });
    }
    if (isPlayers && !guildId && req.method === 'GET') {
      return json(200, [...session.players.values()].map((p) => this.serialize(p)));
    }
    if (!guildId) return error(404, 'Not found');

    if (req.method === 'GET') {
      const player = session.players.get(guildId);
      return player ? json(200, this.serialize(player)) : error(404, 'Player not found');
    }
    if (req.method === 'DELETE') {
      session.players.delete(guildId);
      return json(204);
    }
    if (req.method === 'PATCH') {
      let player = session.players.get(guildId);
      if (!player) {
        player = { guildId, track: null, volume: 100, paused: false, position: 0, endTime: null, filters: {}, voice: {} };
        session.players.set(guildId, player);
      }
      const events: unknown[] = [];
      if (body.voice) player.voice = body.voice;
      if (body.volume !== undefined) player.volume = body.volume;
      if (body.paused !== undefined) player.paused = body.paused;
      if (body.filters !== undefined) player.filters = body.filters;
      if (body.endTime !== undefined) player.endTime = body.endTime;
      if (body.position !== undefined) player.position = body.position;
      if (body.track !== undefined) {
        const noReplace = url.searchParams.get('noReplace') === 'true';
        if (body.track.encoded === null) {
          if (player.track) events.push({ op: 'event', type: 'TrackEndEvent', guildId, track: atPosition(player.track, player.position + 1234), reason: 'stopped' });
          player.track = null;
        } else if (body.track.encoded && !(noReplace && player.track)) {
          if (player.track) events.push({ op: 'event', type: 'TrackEndEvent', guildId, track: atPosition(player.track, player.position + 1234), reason: 'replaced' });
          const track = { ...decodeTrack(body.track.encoded), userData: body.track.userData ?? {} };
          player.track = track;
          player.position = body.position ?? 0;
          events.push({ op: 'event', type: 'TrackStartEvent', guildId, track: atPosition(track, player.position) });
        }
      }
      json(200, this.serialize(player));
      setImmediate(() => {
        for (const event of events) this.send(session, event);
      });
      return;
    }
    return error(405, 'Method not allowed');
  }

  private serialize(player: MockPlayer) {
    return {
      guildId: player.guildId,
      track: player.track ? atPosition(player.track, player.position + 1234) : null,
      volume: player.volume,
      paused: player.paused,
      state: { time: Date.now(), position: player.position, connected: Boolean(player.voice.token), ping: 10 },
      voice: player.voice,
      filters: player.filters,
    };
  }

  private load(identifier: string): LoadResult {
    if (this.loadHandler) return this.loadHandler(identifier);
    const mix = /^https:\/\/www\.youtube\.com\/watch\?v=([^&]+)&list=RD/.exec(identifier);
    if (mix) {
      const seed = mix[1]!;
      const tracks = [makeTrack(`Seed ${seed}`, { identifier: seed }), ...[1, 2, 3].map((i) => makeTrack(`Related ${seed} ${i}`, { identifier: `${seed}-rel-${i}` }))];
      return { loadType: 'playlist', data: { info: { name: 'Mix', selectedTrack: 0 }, pluginInfo: {}, tracks } };
    }
    if (identifier === 'https://example.com/playlist') {
      const tracks = [1, 2, 3].map((i) => makeTrack(`Playlist Song ${i}`, { identifier: `pl-${i}` }));
      return { loadType: 'playlist', data: { info: { name: 'Mock Playlist', selectedTrack: -1 }, pluginInfo: {}, tracks } };
    }
    if (identifier === 'https://example.com/track') {
      return { loadType: 'track', data: makeTrack('Direct Track', { identifier: 'direct' }) };
    }
    if (identifier.includes('error')) {
      return { loadType: 'error', data: { message: 'Load failed', severity: 'common', cause: 'mock' } };
    }
    if (identifier.startsWith('sprec:')) {
      if (!this.spotifyRecommendations) {
        return { loadType: 'error', data: { message: 'Recommendations need Extended quota mode', severity: 'common', cause: 'mock' } };
      }
      const seed = identifier.split(':').pop()!.replace(/\W+/g, '');
      const tracks = [1, 2, 3].map((i) => makeTrack(`Recommended ${seed} ${i}`, { identifier: `rec-${seed}-${i}`, sourceName: 'spotify' }));
      return { loadType: 'playlist', data: { info: { name: 'Radio', selectedTrack: -1 }, pluginInfo: {}, tracks } };
    }
    const search = /^(\w+):(.+)$/.exec(identifier);
    if (search && search[1]!.endsWith('search')) {
      const prefix = search[1]!;
      const query = search[2]!;
      const sourceName = prefix.startsWith('sp') ? 'spotify' : prefix.startsWith('sc') ? 'soundcloud' : prefix.startsWith('dz') ? 'deezer' : 'youtube';
      const idPrefix = sourceName === 'youtube' ? '' : `${prefix.slice(0, 2)}-`;
      const tracks = [1, 2, 3, 4, 5].map((i) =>
        makeTrack(`${query} ${i}`, { identifier: `${idPrefix}${query.replace(/\W+/g, '')}-${i}`, author: `Artist of ${query}`, sourceName }),
      );
      return { loadType: 'search', data: tracks };
    }
    return { loadType: 'empty', data: {} };
  }
}
