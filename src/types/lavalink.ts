/**
 * Lavalink v4 protocol types (REST + WebSocket).
 * https://lavalink.dev/api/
 */

// ==================== Tracks ====================

export interface TrackInfo {
  identifier: string;
  isSeekable: boolean;
  author: string;
  /** Length in milliseconds */
  length: number;
  isStream: boolean;
  /** Start position in milliseconds */
  position: number;
  title: string;
  uri: string | null;
  artworkUrl: string | null;
  isrc: string | null;
  sourceName: string;
}

/** A track exactly as Lavalink returns it. */
export interface LavalinkTrack {
  /** Base64 encoded track data */
  encoded: string;
  info: TrackInfo;
  pluginInfo: Record<string, unknown>;
  userData: Record<string, unknown>;
}

export interface PlaylistInfo {
  name: string;
  /** Selected track index, -1 when none */
  selectedTrack: number;
}

export type ExceptionSeverity = 'common' | 'suspicious' | 'fault';

export interface LavalinkException {
  message: string | null;
  severity: ExceptionSeverity;
  cause: string;
  causeStackTrace?: string;
}

// ==================== Load results ====================

export type LoadResult =
  | { loadType: 'track'; data: LavalinkTrack }
  | { loadType: 'playlist'; data: { info: PlaylistInfo; pluginInfo: Record<string, unknown>; tracks: LavalinkTrack[] } }
  | { loadType: 'search'; data: LavalinkTrack[] }
  | { loadType: 'empty'; data: Record<string, never> }
  | { loadType: 'error'; data: LavalinkException };

export type LoadType = LoadResult['loadType'];

// ==================== Filters ====================

export interface EqualizerBand {
  /** 0 - 14 */
  band: number;
  /** -0.25 - 1.0 */
  gain: number;
}

export interface KaraokeFilter {
  level?: number;
  monoLevel?: number;
  filterBand?: number;
  filterWidth?: number;
}

export interface TimescaleFilter {
  speed?: number;
  pitch?: number;
  rate?: number;
}

export interface TremoloFilter {
  frequency?: number;
  depth?: number;
}

export interface VibratoFilter {
  frequency?: number;
  depth?: number;
}

export interface RotationFilter {
  rotationHz?: number;
}

export interface DistortionFilter {
  sinOffset?: number;
  sinScale?: number;
  cosOffset?: number;
  cosScale?: number;
  tanOffset?: number;
  tanScale?: number;
  offset?: number;
  scale?: number;
}

export interface ChannelMixFilter {
  leftToLeft?: number;
  leftToRight?: number;
  rightToLeft?: number;
  rightToRight?: number;
}

export interface LowPassFilter {
  smoothing?: number;
}

export interface FilterOptions {
  /** 0.0 - 5.0, where 1.0 is 100% */
  volume?: number;
  equalizer?: EqualizerBand[];
  karaoke?: KaraokeFilter | null;
  timescale?: TimescaleFilter | null;
  tremolo?: TremoloFilter | null;
  vibrato?: VibratoFilter | null;
  rotation?: RotationFilter | null;
  distortion?: DistortionFilter | null;
  channelMix?: ChannelMixFilter | null;
  lowPass?: LowPassFilter | null;
  /** Filters provided by Lavalink plugins, keyed by filter name */
  pluginFilters?: Record<string, unknown>;
}

// ==================== Player (REST) ====================

export interface VoiceState {
  token: string;
  endpoint: string;
  sessionId: string;
  /** Voice channel id. Required by Lavalink builds with DAVE (E2EE voice) support. */
  channelId?: string;
}

export interface LavalinkPlayerState {
  /** Unix timestamp in milliseconds */
  time: number;
  /** Track position in milliseconds */
  position: number;
  /** Whether Lavalink is connected to the voice gateway */
  connected: boolean;
  /** Voice gateway ping in milliseconds, -1 if not connected */
  ping: number;
}

export interface LavalinkPlayer {
  guildId: string;
  track: LavalinkTrack | null;
  volume: number;
  paused: boolean;
  state: LavalinkPlayerState;
  voice: VoiceState;
  filters: FilterOptions;
}

export interface UpdatePlayerTrack {
  /** Encoded track, or null to stop the current track */
  encoded?: string | null;
  /** Identifier to resolve and play. Mutually exclusive with `encoded`. */
  identifier?: string;
  userData?: Record<string, unknown>;
}

export interface UpdatePlayerPayload {
  track?: UpdatePlayerTrack;
  position?: number;
  /** End time in milliseconds, null to reset */
  endTime?: number | null;
  /** 0 - 1000 */
  volume?: number;
  paused?: boolean;
  filters?: FilterOptions;
  voice?: VoiceState;
}

// ==================== Session ====================

export interface SessionUpdatePayload {
  resuming?: boolean;
  /** Seconds */
  timeout?: number;
}

export interface SessionInfo {
  resuming: boolean;
  timeout: number;
}

// ==================== Info & stats ====================

export interface NodeInfo {
  version: {
    semver: string;
    major: number;
    minor: number;
    patch: number;
    preRelease: string | null;
    build: string | null;
  };
  buildTime: number;
  git: { branch: string; commit: string; commitTime: number };
  jvm: string;
  lavaplayer: string;
  sourceManagers: string[];
  filters: string[];
  plugins: Array<{ name: string; version: string }>;
}

export interface NodeStats {
  players: number;
  playingPlayers: number;
  /** Milliseconds */
  uptime: number;
  memory: { free: number; used: number; allocated: number; reservable: number };
  cpu: { cores: number; systemLoad: number; lavalinkLoad: number };
  frameStats: { sent: number; nulled: number; deficit: number } | null;
}

// ==================== Route planner ====================

export interface RoutePlannerStatus {
  class: string | null;
  details: {
    ipBlock: { type: string; size: string };
    failingAddresses: Array<{ failingAddress: string; failingTimestamp: number; failingTime: string }>;
    rotateIndex?: string;
    ipIndex?: string;
    currentAddress?: string;
    currentAddressIndex?: string;
    blockIndex?: string;
  } | null;
}

// ==================== Error response ====================

export interface LavalinkErrorResponse {
  timestamp: number;
  status: number;
  error: string;
  trace?: string;
  message: string;
  path: string;
}

// ==================== WebSocket ====================

export type TrackEndReason = 'finished' | 'loadFailed' | 'stopped' | 'replaced' | 'cleanup';

export interface ReadyOp {
  op: 'ready';
  resumed: boolean;
  sessionId: string;
}

export interface PlayerUpdateOp {
  op: 'playerUpdate';
  guildId: string;
  state: LavalinkPlayerState;
}

export interface StatsOp extends NodeStats {
  op: 'stats';
}

export interface TrackStartEvent {
  op: 'event';
  type: 'TrackStartEvent';
  guildId: string;
  track: LavalinkTrack;
}

export interface TrackEndEvent {
  op: 'event';
  type: 'TrackEndEvent';
  guildId: string;
  track: LavalinkTrack;
  reason: TrackEndReason;
}

export interface TrackExceptionEvent {
  op: 'event';
  type: 'TrackExceptionEvent';
  guildId: string;
  track: LavalinkTrack;
  exception: LavalinkException;
}

export interface TrackStuckEvent {
  op: 'event';
  type: 'TrackStuckEvent';
  guildId: string;
  track: LavalinkTrack;
  thresholdMs: number;
}

export interface WebSocketClosedEvent {
  op: 'event';
  type: 'WebSocketClosedEvent';
  guildId: string;
  code: number;
  reason: string;
  byRemote: boolean;
}

/** Any event emitted by a Lavalink plugin (LavaLyrics, SponsorBlock, ...). */
export interface PluginEvent {
  op: 'event';
  type: string;
  guildId: string;
  [key: string]: unknown;
}

export type CoreEvent =
  | TrackStartEvent
  | TrackEndEvent
  | TrackExceptionEvent
  | TrackStuckEvent
  | WebSocketClosedEvent;

export type IncomingMessage = ReadyOp | PlayerUpdateOp | StatsOp | CoreEvent | PluginEvent;

// ==================== Plugins ====================

/** LavaLyrics response */
export interface Lyrics {
  sourceName: string;
  provider: string;
  text: string | null;
  lines: LyricsLine[];
  plugin: Record<string, unknown>;
}

export interface LyricsLine {
  /** Milliseconds */
  timestamp: number;
  /** Milliseconds, null when unknown */
  duration: number | null;
  line: string;
  plugin: Record<string, unknown>;
}

/** LavaSearch result */
export interface LavaSearchResult {
  tracks: LavalinkTrack[];
  albums: Array<{ info: PlaylistInfo; pluginInfo: Record<string, unknown>; tracks: LavalinkTrack[] }>;
  artists: Array<{ info: PlaylistInfo; pluginInfo: Record<string, unknown>; tracks: LavalinkTrack[] }>;
  playlists: Array<{ info: PlaylistInfo; pluginInfo: Record<string, unknown>; tracks: LavalinkTrack[] }>;
  texts: Array<{ text: string; plugin: Record<string, unknown> }>;
  plugin: Record<string, unknown>;
}

export type LavaSearchType = 'track' | 'album' | 'artist' | 'playlist' | 'text';

// ==================== Discord gateway ====================

export interface DiscordVoiceStateUpdatePayload {
  op: 4;
  d: {
    guild_id: string;
    channel_id: string | null;
    self_mute: boolean;
    self_deaf: boolean;
  };
}

export interface GatewayVoiceServerUpdate {
  token: string;
  guild_id: string;
  endpoint: string | null;
}

export interface GatewayVoiceState {
  guild_id?: string;
  channel_id: string | null;
  user_id: string;
  session_id: string;
  member?: { user?: { id: string; bot?: boolean } };
}

/** Minimal shape of a raw Discord gateway dispatch packet. */
export interface GatewayPacket {
  op?: number;
  t?: string | null;
  d?: unknown;
}
