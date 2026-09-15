import type { Node } from './Node';
import type {
  LavaSearchResult,
  LavaSearchType,
  LavalinkErrorResponse,
  LavalinkPlayer,
  LavalinkTrack,
  LoadResult,
  Lyrics,
  NodeInfo,
  NodeStats,
  RoutePlannerStatus,
  SessionInfo,
  SessionUpdatePayload,
  UpdatePlayerPayload,
} from '../types/lavalink';
import { RayaError, RestError } from '../utils/errors';
import { sleep } from '../utils/backoff';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Retries for network errors, timeouts, 429 and 502-504. Default: 2 for GET, 0 otherwise */
  retries?: number;
  /** Per-request timeout override in ms */
  timeout?: number;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * REST client bound to a single node.
 */
export class Rest {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  /** Total requests sent */
  public requests = 0;
  /** Exponentially weighted average latency of successful requests in ms, -1 until measured */
  public latency = -1;

  constructor(
    private readonly node: Node,
    clientName: string,
  ) {
    const { secure, host, port, password } = node.options;
    this.baseUrl = `${secure ? 'https' : 'http'}://${host}:${port}`;
    this.headers = {
      Authorization: password,
      'Client-Name': clientName,
      'User-Agent': clientName,
    };
  }

  // ==================== Core ====================

  public async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    let url = this.baseUrl + path;
    if (options.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) params.append(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const retries = options.retries ?? (method === 'GET' ? 2 : 0);
    const timeout = options.timeout ?? this.node.options.requestTimeout;
    const headers: Record<string, string> = { ...this.headers };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      this.requests++;
      let response: Response;
      try {
        response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        if (attempt < retries) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw new RayaError(
          timedOut ? 'REST_TIMEOUT' : 'NETWORK_ERROR',
          `${method} ${path} ${timedOut ? `timed out after ${timeout}ms` : 'failed'} on node "${this.node.name}"`,
          { cause: error },
        );
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt);
          continue;
        }
        let parsed: LavalinkErrorResponse | null = null;
        try {
          parsed = text ? (JSON.parse(text) as LavalinkErrorResponse) : null;
        } catch {
          parsed = null;
        }
        throw new RestError(method, path, response.status, parsed, text || undefined);
      }

      const elapsed = Date.now() - started;
      this.latency = this.latency < 0 ? elapsed : Math.round(this.latency * 0.8 + elapsed * 0.2);

      if (response.status === 204) return undefined as T;
      const text = await response.text();
      if (!text) return undefined as T;
      const type = response.headers.get('content-type') ?? '';
      if (type.includes('json')) return JSON.parse(text) as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    }
  }

  private session(): string {
    if (!this.node.sessionId || !this.node.connected) {
      throw new RayaError('NODE_NOT_READY', `Node "${this.node.name}" has no ready session`);
    }
    return `/v4/sessions/${this.node.sessionId}`;
  }

  // ==================== Tracks ====================

  public loadTracks(identifier: string): Promise<LoadResult> {
    return this.request<LoadResult>('GET', '/v4/loadtracks', { query: { identifier } });
  }

  public decodeTrack(encodedTrack: string): Promise<LavalinkTrack> {
    return this.request<LavalinkTrack>('GET', '/v4/decodetrack', { query: { encodedTrack } });
  }

  public decodeTracks(encodedTracks: string[]): Promise<LavalinkTrack[]> {
    return this.request<LavalinkTrack[]>('POST', '/v4/decodetracks', { body: encodedTracks, retries: 2 });
  }

  // ==================== Players ====================

  public getPlayers(): Promise<LavalinkPlayer[]> {
    return this.request<LavalinkPlayer[]>('GET', `${this.session()}/players`);
  }

  public getPlayer(guildId: string): Promise<LavalinkPlayer> {
    return this.request<LavalinkPlayer>('GET', `${this.session()}/players/${guildId}`);
  }

  public updatePlayer(guildId: string, payload: UpdatePlayerPayload, noReplace = false): Promise<LavalinkPlayer> {
    return this.request<LavalinkPlayer>('PATCH', `${this.session()}/players/${guildId}`, {
      body: payload,
      query: noReplace ? { noReplace: true } : undefined,
    });
  }

  public async destroyPlayer(guildId: string): Promise<void> {
    await this.request<void>('DELETE', `${this.session()}/players/${guildId}`);
  }

  public updateSession(payload: SessionUpdatePayload): Promise<SessionInfo> {
    return this.request<SessionInfo>('PATCH', this.session(), { body: payload });
  }

  // ==================== Info ====================

  public info(): Promise<NodeInfo> {
    return this.request<NodeInfo>('GET', '/v4/info');
  }

  public stats(): Promise<NodeStats> {
    return this.request<NodeStats>('GET', '/v4/stats');
  }

  public version(): Promise<string> {
    return this.request<string>('GET', '/version');
  }

  // ==================== Route planner ====================

  public routePlannerStatus(): Promise<RoutePlannerStatus> {
    return this.request<RoutePlannerStatus>('GET', '/v4/routeplanner/status');
  }

  public async unmarkFailedAddress(address: string): Promise<void> {
    await this.request<void>('POST', '/v4/routeplanner/free/address', { body: { address } });
  }

  public async unmarkAllFailedAddresses(): Promise<void> {
    await this.request<void>('POST', '/v4/routeplanner/free/all');
  }

  // ==================== Plugins ====================

  /** LavaLyrics: lyrics for any encoded track. Resolves null when none are found. */
  public async getLyrics(encodedTrack: string, skipTrackSource = false): Promise<Lyrics | null> {
    return (await this.request<Lyrics | undefined>('GET', '/v4/lyrics', {
      query: { track: encodedTrack, skipTrackSource },
    })) ?? null;
  }

  /** LavaLyrics: lyrics for the track a player is currently playing. */
  public async getPlayerLyrics(guildId: string, skipTrackSource = false): Promise<Lyrics | null> {
    return (await this.request<Lyrics | undefined>('GET', `${this.session()}/players/${guildId}/track/lyrics`, {
      query: { skipTrackSource },
    })) ?? null;
  }

  /** LavaLyrics: receive lyricsFound / lyricsLine events for a player. */
  public async subscribeLyrics(guildId: string, skipTrackSource = false): Promise<void> {
    await this.request<void>('POST', `${this.session()}/players/${guildId}/lyrics/subscribe`, {
      query: { skipTrackSource },
    });
  }

  public async unsubscribeLyrics(guildId: string): Promise<void> {
    await this.request<void>('DELETE', `${this.session()}/players/${guildId}/lyrics/subscribe`);
  }

  /** LavaSearch: rich search across tracks, albums, artists, playlists and text. */
  public async loadSearch(query: string, types: LavaSearchType[] = []): Promise<LavaSearchResult | null> {
    return (await this.request<LavaSearchResult | undefined>('GET', '/v4/loadsearch', {
      query: { query, types: types.length ? types.join(',') : undefined },
    })) ?? null;
  }

  /** SponsorBlock plugin */
  public getSponsorBlockCategories(guildId: string): Promise<string[]> {
    return this.request<string[]>('GET', `${this.session()}/players/${guildId}/sponsorblock/categories`);
  }

  public async setSponsorBlockCategories(guildId: string, categories: string[]): Promise<void> {
    await this.request<void>('PUT', `${this.session()}/players/${guildId}/sponsorblock/categories`, {
      body: categories,
    });
  }

  public async clearSponsorBlockCategories(guildId: string): Promise<void> {
    await this.request<void>('DELETE', `${this.session()}/players/${guildId}/sponsorblock/categories`);
  }
}
