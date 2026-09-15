import type { Node } from '../node/Node';
import type { Player } from '../player/Player';
import type { Queue } from '../player/Queue';
import type { Raya } from '../Raya';
import type { VoiceStatusOptions } from '../plugins/VoiceStatus';
import type { SearchSourceAlias, SearchSources } from '../utils/sources';
import type {
  DiscordVoiceStateUpdatePayload,
  FilterOptions,
  LavalinkException,
  LavalinkPlayerState,
  LavalinkTrack,
  LoadType,
  Lyrics,
  LyricsLine,
  NodeStats,
  PluginEvent,
  TrackEndReason,
  VoiceState,
} from './lavalink';

// ==================== Custom typing ====================

/**
 * Augment this interface to type the `requester` stored on tracks:
 *
 * ```ts
 * declare module 'raya.js' {
 *   interface CustomTypes { requester: { id: string; username: string } }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface CustomTypes {}

export type Requester = CustomTypes extends { requester: infer R } ? R : unknown;

/** A Lavalink track plus the client-side requester. */
export interface Track extends LavalinkTrack {
  requester?: Requester;
}

export type LoopMode = 'off' | 'track' | 'queue';

// ==================== Nodes ====================

export interface NodeRetryOptions {
  /** Reconnect attempts before the node is given up on. Default: Infinity */
  maxAttempts?: number;
  /** First reconnect delay in ms. Default: 1000 */
  baseDelay?: number;
  /** Upper bound for the reconnect delay in ms. Default: 30000 */
  maxDelay?: number;
}

export interface NodeOptions {
  /** Unique name. Default: `host:port` */
  name?: string;
  host: string;
  /** Default: 443 when secure, otherwise 2333 */
  port?: number;
  password: string;
  /** Use wss/https. Default: false */
  secure?: boolean;
  /** Voice regions this node is close to, e.g. ['us', 'us-east', 'atl']. Enables region-aware routing. */
  regions?: string[];
  retry?: NodeRetryOptions;
  /** REST request timeout in ms. Default: 10000 */
  requestTimeout?: number;
  /** Seconds Lavalink keeps the session alive after a disconnect. 0 disables resuming. Default: 60 */
  resumeTimeout?: number;
  /** WebSocket ping interval in ms, used for dead-connection detection and latency. Default: 20000 */
  pingInterval?: number;
  /** Resume this existing Lavalink session on first connect. */
  sessionId?: string;
}

export interface ResolvedNodeOptions {
  name: string;
  host: string;
  port: number;
  password: string;
  secure: boolean;
  regions: string[];
  retry: Required<NodeRetryOptions>;
  requestTimeout: number;
  resumeTimeout: number;
  pingInterval: number;
  sessionId: string | null;
}

// ==================== Players ====================

export interface PlayerDefaults {
  /** 0 - 1000. Default: 100 */
  volume?: number;
  /** Default: true */
  selfDeaf?: boolean;
  /** Default: false */
  selfMute?: boolean;
  /** Default: 'off' */
  loop?: LoopMode;
  /** Keep playing related tracks when the queue runs out. Default: false */
  autoplay?: boolean;
  /** Max tracks in a queue. Default: 10000 */
  maxQueueSize?: number;
  /** How many played tracks to remember. Default: 50 */
  historySize?: number;
  /** Destroy the player this many ms after the queue ends. Default: false (never) */
  queueEndTimeout?: number | false;
  /** Destroy the player this many ms after its voice channel has no humans left. Default: false (never) */
  emptyChannelTimeout?: number | false;
  /** Pause while the voice channel is empty and resume when someone returns. Default: false */
  pauseOnEmpty?: boolean;
  /** Skip tracks that get stuck. Default: true */
  skipOnStuck?: boolean;
  /** Destroy the player when the bot is disconnected from voice (kicked, channel deleted). Default: true */
  destroyOnVoiceDisconnect?: boolean;
  /** Max ms to wait for Discord voice credentials in `connect()`. Default: 15000 */
  voiceTimeout?: number;
}

export type ResolvedPlayerDefaults = Required<PlayerDefaults>;

export interface CreatePlayerOptions {
  guildId: string;
  voiceChannelId: string;
  textChannelId?: string | null;
  /** Force a node by name or instance */
  node?: string | Node;
  /** Preferred voice region for node selection */
  region?: string;
  selfDeaf?: boolean;
  selfMute?: boolean;
  volume?: number;
  loop?: LoopMode;
  autoplay?: boolean;
}

export interface PlayOptions {
  /** Start position in ms */
  startTime?: number;
  /** Stop the track at this position in ms */
  endTime?: number;
  paused?: boolean;
  volume?: number;
  /** Do nothing if a track is already playing */
  noReplace?: boolean;
  /** Requester when `play` is given an encoded string */
  requester?: Requester;
  /** Push the replaced track into history. Default: true */
  addToHistory?: boolean;
}

// ==================== Search ====================

/** A source alias, a known Lavalink search prefix, or any custom prefix. */
export type SearchSource = SearchSourceAlias | (typeof SearchSources)[SearchSourceAlias] | (string & {});

export interface SearchOptions {
  /** Search source: a known alias ('youtube', 'spotify', ...) or a raw prefix ('ytsearch', 'spsearch'). */
  source?: SearchSource;
  /** Node to run the search on. Default: best node */
  node?: string | Node;
  /** Attached to every returned track */
  requester?: Requester;
  /** Use the search cache. Default: true */
  cache?: boolean;
}

export interface SearchResult {
  type: LoadType;
  /** Always an array: the track, the search results or the playlist tracks */
  tracks: Track[];
  playlist: {
    name: string;
    selectedTrack: number;
    pluginInfo: Record<string, unknown>;
    /** Sum of non-stream track lengths in ms */
    duration: number;
  } | null;
  exception: LavalinkException | null;
  /** The identifier sent to Lavalink */
  identifier: string;
  /** Whether the result came from the cache */
  cached: boolean;
}

export interface SearchCacheOptions {
  /** Default: 500 */
  maxSize?: number;
  /** Default: 300000 (5 minutes) */
  ttl?: number;
}

// ==================== Manager ====================

export type AutoplayResolver = (player: Player, lastTrack: Track) => Promise<Track | null | undefined>;

export interface Connector {
  /** Wire Discord raw events into `raya.handleRaw` and call `raya.init(userId)` once ready. */
  attach(raya: Raya): void;
  /** Send an opcode 4 payload to the shard that owns the guild. */
  send(guildId: string, payload: DiscordVoiceStateUpdatePayload): void | Promise<void>;
  /** The bot token, used by features that call the Discord REST API (voice channel status). */
  getToken?(): string | null | undefined;
}

export interface RayaPlugin {
  readonly name: string;
  load(raya: Raya): void | Promise<void>;
  unload?(raya: Raya): void | Promise<void>;
}

export interface FailoverOptions {
  /** Move players off a disconnected node. Default: true */
  enabled?: boolean;
  /** Grace period in ms before moving players, giving the node a chance to resume. Default: 5000 */
  delay?: number;
}

export type NodeSelector = (nodes: Node[], context: { region?: string; guildId?: string }) => Node | undefined;

export interface RayaOptions {
  nodes: NodeOptions[];
  /** Discord library connector. Alternative to `send` + manual `handleRaw`/`init`. */
  connector?: Connector;
  /** Sends opcode 4 payloads to Discord. Required unless a connector is used. */
  send?: (guildId: string, payload: DiscordVoiceStateUpdatePayload) => void | Promise<void>;
  /** Sent as the Client-Name header. Default: `Raya/<version>` */
  clientName?: string;
  /**
   * Source used when a query is not a URL. An alias ('youtube', 'spotify', ...) or a raw
   * Lavalink prefix ('ytsearch', 'spsearch', ...). Default: 'youtube'
   */
  defaultSearchSource?: SearchSource;
  /** Log debug messages: `true` prints to the console, or pass your own logger. Default: false */
  debug?: boolean | ((message: string) => void);
  /** Show the playing track as the voice channel status. `true` uses the defaults. */
  voiceStatus?: VoiceStatusOptions | boolean;
  playerDefaults?: PlayerDefaults;
  /** Search result cache, or false to disable. */
  searchCache?: SearchCacheOptions | false;
  failover?: FailoverOptions;
  /** Custom autoplay strategy. Default: built-in multi-source resolver */
  autoplayResolver?: AutoplayResolver;
  /** Transform requesters before they are stored (e.g. keep only id + name). */
  requesterTransformer?: (requester: unknown) => Requester;
  /** Custom node selection. Return undefined to fall back to the default penalty balancer. */
  nodeSelector?: NodeSelector;
  /** Restore players from `raya.snapshot()` / `raya.shutdown()` taken by a previous process. */
  restore?: RayaSnapshot;
}

// ==================== Snapshots ====================

export interface PlayerSnapshot {
  guildId: string;
  voiceChannelId: string | null;
  textChannelId: string | null;
  node: string;
  selfDeaf: boolean;
  selfMute: boolean;
  volume: number;
  paused: boolean;
  loop: LoopMode;
  autoplay: boolean;
  track: Track | null;
  position: number;
  filters: FilterOptions;
  queue: Track[];
  history: Track[];
  voice: Partial<VoiceState>;
  data: Record<string, unknown>;
}

export interface RayaSnapshot {
  version: 1;
  createdAt: number;
  userId: string | null;
  /** Lavalink session ids by node name */
  sessions: Record<string, string>;
  players: PlayerSnapshot[];
}

// ==================== Events ====================

export interface NodeDisconnectInfo {
  code: number;
  reason: string;
  /** Whether the node had a ready session before disconnecting */
  wasReady: boolean;
}

export interface SocketClosedInfo {
  code: number;
  reason: string;
  byRemote: boolean;
}

export type PlayerDestroyReason =
  | 'manual'
  | 'queueEnd'
  | 'channelEmpty'
  | 'voiceDisconnected'
  | 'channelDeleted'
  | 'guildDeleted'
  | 'shutdown'
  | (string & {});

export type RayaEvents = {
  ready: [];
  debug: [message: string];

  nodeAdd: [node: Node];
  nodeRemove: [node: Node];
  nodeReady: [node: Node, resumed: boolean];
  nodeDisconnect: [node: Node, info: NodeDisconnectInfo];
  nodeReconnecting: [node: Node, attempt: number, delay: number];
  nodeError: [node: Node, error: Error];
  nodeStats: [node: Node, stats: NodeStats];
  nodeRaw: [node: Node, payload: unknown];

  playerCreate: [player: Player];
  playerDestroy: [player: Player, reason: PlayerDestroyReason];
  /** `newChannelId` is null when the bot was disconnected from voice */
  playerMove: [player: Player, oldChannelId: string | null, newChannelId: string | null];
  playerNodeMove: [player: Player, from: Node, to: Node];
  playerUpdate: [player: Player, state: LavalinkPlayerState];
  playerResume: [player: Player];
  playerError: [player: Player, error: Error];
  voiceChannelEmpty: [player: Player];
  voiceChannelFilled: [player: Player];
  socketClosed: [player: Player, info: SocketClosedInfo];

  trackStart: [player: Player, track: Track];
  trackEnd: [player: Player, track: Track, reason: TrackEndReason];
  trackStuck: [player: Player, track: Track, thresholdMs: number];
  trackError: [player: Player, track: Track, exception: LavalinkException];
  queueEnd: [player: Player, lastTrack: Track | null];
  queueUpdate: [player: Player, queue: Queue];

  lyricsFound: [player: Player, lyrics: Lyrics];
  lyricsNotFound: [player: Player];
  lyricsLine: [player: Player, line: LyricsLine, lineIndex: number, skipped: boolean];
  segmentsLoaded: [player: Player, segments: unknown[]];
  segmentSkipped: [player: Player, segment: unknown];
  chaptersLoaded: [player: Player, chapters: unknown[]];
  chapterStarted: [player: Player, chapter: unknown];
  /** Every non-core Lavalink event, including the plugin events above */
  pluginEvent: [player: Player, event: PluginEvent];
};
