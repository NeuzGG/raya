/**
 * Lavalink v4 Type Definitions
 * Complete type-safe interfaces for Lavalink REST API and WebSocket protocol
 */

// ==================== Core Node Types ====================

export interface NodeOptions {
  /** Unique identifier for the node */
  name: string;
  /** Hostname or IP address */
  host: string;
  /** Port number */
  port: number;
  /** Authorization password */
  password: string;
  /** Whether to use secure connection (wss/https) */
  secure?: boolean;
  /** Resume key for session restoration */
  resumeKey?: string;
  /** Resume timeout in seconds */
  resumeTimeout?: number;
  /** Maximum number of reconnection attempts */
  maxReconnectAttempts?: number;
  /** Base reconnection delay in milliseconds */
  reconnectDelay?: number;
  /** Geographic region for voice optimization (e.g., 'us-west', 'eu-central') */
  region?: string;
  /** Retry strategy for rate limiting */
  retryStrategy?: 'exponential' | 'linear' | 'none';
}

export interface NodeStats {
  /** Number of players on the node */
  players: number;
  /** Number of playing players */
  playingPlayers: number;
  /** Uptime in milliseconds */
  uptime: number;
  /** Memory stats */
  memory: {
    free: number;
    used: number;
    allocated: number;
    reservable: number;
  };
  /** CPU stats */
  cpu: {
    cores: number;
    systemLoad: number;
    lavalinkLoad: number;
  };
  /** Frame stats (nullable) */
  frameStats: {
    sent: number;
    nulled: number;
    deficit: number;
  } | null;
}

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
  git: {
    branch: string;
    commit: string;
    commitTime: number;
  };
  jvm: string;
  lavaplayer: string;
  sourceManagers: string[];
  filters: string[];
  plugins: Array<{
    name: string;
    version: string;
  }>;
}

// ==================== Track & Search Types ====================

export interface Track {
  /** Base64 encoded track data */
  encoded: string;
  /** Track information */
  info: TrackInfo;
  /** Plugin-specific data */
  pluginInfo: Record<string, unknown>;
  /** User data (v4) */
  userData?: Record<string, unknown>;
}

export interface TrackInfo {
  /** Track identifier */
  identifier: string;
  /** Whether the track is seekable */
  isSeekable: boolean;
  /** Track author */
  author: string;
  /** Track length in milliseconds */
  length: number;
  /** Whether the track is a stream */
  isStream: boolean;
  /** Track position in milliseconds */
  position: number;
  /** Track title */
  title: string;
  /** Track URI */
  uri: string | null;
  /** Track artwork URL */
  artworkUrl: string | null;
  /** ISRC identifier */
  isrc: string | null;
  /** Source name (youtube, soundcloud, etc.) */
  sourceName: string;
}

export interface Playlist {
  /** Playlist information */
  info: PlaylistInfo;
  /** Plugin-specific data */
  pluginInfo: Record<string, unknown>;
  /** Tracks in the playlist */
  tracks: Track[];
}

export interface PlaylistInfo {
  /** Playlist name */
  name: string;
  /** Selected track index (-1 if none) */
  selectedTrack: number;
}

export interface LoadResultTrack {
  loadType: 'track';
  data: Track;
}

export interface LoadResultPlaylist {
  loadType: 'playlist';
  data: Playlist;
}

export interface LoadResultSearch {
  loadType: 'search';
  data: Track[];
}

export interface LoadResultEmpty {
  loadType: 'empty';
  data: Record<string, never>;
}

export interface LoadResultError {
  loadType: 'error';
  data: {
    message: string;
    severity: 'common' | 'suspicious' | 'fault';
    cause: string;
  };
}

export type LoadResult =
  | LoadResultTrack
  | LoadResultPlaylist
  | LoadResultSearch
  | LoadResultEmpty
  | LoadResultError;

// ==================== Player Types ====================

export interface PlayerState {
  /** Current track position in milliseconds */
  time: number;
  /** Current track position */
  position: number;
  /** Whether the player is connected */
  connected: boolean;
  /** Ping in milliseconds */
  ping: number;
}

export interface VoiceState {
  /** Voice token from Discord */
  token: string;
  /** Voice endpoint from Discord */
  endpoint: string;
  /** Session ID from Discord */
  sessionId: string;
  /** Voice channel ID (required by stricter Lavalink/Discord voice paths) */
  channelId?: string;
}

export interface PlayerUpdateOptions {
  /** Track to play */
  encodedTrack?: string | null;
  /** Track identifier (alternative to encodedTrack) */
  identifier?: string;
  /** Start position in milliseconds */
  position?: number;
  /** End position in milliseconds */
  endTime?: number;
  /** Volume (0-1000) */
  volume?: number;
  /** Whether the player is paused */
  paused?: boolean;
  /** Filter settings */
  filters?: FilterOptions;
  /** Voice state */
  voice?: VoiceState;
}

export interface PlayerOptions {
  /** Guild ID */
  guildId: string;
  /** Voice channel ID */
  voiceChannelId: string;
  /** Text channel ID (optional) */
  textChannelId?: string;
  /** Whether to self-deafen */
  selfDeafen?: boolean;
  /** Whether to self-mute */
  selfMute?: boolean;
  /** Initial volume (0-100) */
  volume?: number;
}

// ==================== Filter Types ====================

export interface FilterOptions {
  /** Volume filter (0.0 - 5.0) */
  volume?: number;
  /** Equalizer bands */
  equalizer?: EqualizerBand[];
  /** Karaoke effect */
  karaoke?: KaraokeFilter;
  /** Timescale effect */
  timescale?: TimescaleFilter;
  /** Tremolo effect */
  tremolo?: TremoloFilter;
  /** Vibrato effect */
  vibrato?: VibratoFilter;
  /** Rotation effect */
  rotation?: RotationFilter;
  /** Distortion effect */
  distortion?: DistortionFilter;
  /** Channel mix */
  channelMix?: ChannelMixFilter;
  /** Low pass filter */
  lowPass?: LowPassFilter;
}

export interface EqualizerBand {
  /** Band number (0-14) */
  band: number;
  /** Gain (-0.25 to 1.0) */
  gain: number;
}

export interface KaraokeFilter {
  /** Level (0.0 - 1.0) */
  level?: number;
  /** Mono level (0.0 - 1.0) */
  monoLevel?: number;
  /** Filter band (in Hz) */
  filterBand?: number;
  /** Filter width */
  filterWidth?: number;
}

export interface TimescaleFilter {
  /** Speed (>0) */
  speed?: number;
  /** Pitch (>0) */
  pitch?: number;
  /** Rate (>0) */
  rate?: number;
}

export interface TremoloFilter {
  /** Frequency (>0) */
  frequency: number;
  /** Depth (0.0 - 1.0) */
  depth: number;
}

export interface VibratoFilter {
  /** Frequency (0.0 - 14.0) */
  frequency: number;
  /** Depth (0.0 - 1.0) */
  depth: number;
}

export interface RotationFilter {
  /** Rotation speed in Hz */
  rotationHz: number;
}

export interface DistortionFilter {
  sinOffset: number;
  sinScale: number;
  cosOffset: number;
  cosScale: number;
  tanOffset: number;
  tanScale: number;
  offset: number;
  scale: number;
}

export interface ChannelMixFilter {
  /** Left to left channel mix (0.0 - 1.0) */
  leftToLeft?: number;
  /** Left to right channel mix (0.0 - 1.0) */
  leftToRight?: number;
  /** Right to left channel mix (0.0 - 1.0) */
  rightToLeft?: number;
  /** Right to right channel mix (0.0 - 1.0) */
  rightToRight?: number;
}

export interface LowPassFilter {
  /** Smoothing factor */
  smoothing: number;
}

// ==================== WebSocket Event Types ====================

export interface ReadyEvent {
  op: 'ready';
  resumed: boolean;
  sessionId: string;
}

export interface PlayerUpdateEvent {
  op: 'playerUpdate';
  guildId: string;
  state: PlayerState;
}

export interface StatsEvent {
  op: 'stats';
  players: number;
  playingPlayers: number;
  uptime: number;
  memory: NodeStats['memory'];
  cpu: NodeStats['cpu'];
  frameStats: NodeStats['frameStats'];
}

export interface TrackStartEvent {
  op: 'event';
  type: 'TrackStartEvent';
  guildId: string;
  track: Track;
}

export interface TrackEndEvent {
  op: 'event';
  type: 'TrackEndEvent';
  guildId: string;
  track: Track;
  reason: TrackEndReason;
}

export type TrackEndReason =
  | 'finished'
  | 'loadFailed'
  | 'stopped'
  | 'replaced'
  | 'cleanup'
  | 'FINISHED'
  | 'LOAD_FAILED'
  | 'STOPPED'
  | 'REPLACED'
  | 'CLEANUP';

export interface TrackExceptionEvent {
  op: 'event';
  type: 'TrackExceptionEvent';
  guildId: string;
  track: Track;
  exception: {
    message: string;
    severity: 'common' | 'suspicious' | 'fault';
    cause: string;
  };
}

export interface TrackStuckEvent {
  op: 'event';
  type: 'TrackStuckEvent';
  guildId: string;
  track: Track;
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

export type LavalinkEvent =
  | ReadyEvent
  | PlayerUpdateEvent
  | StatsEvent
  | TrackStartEvent
  | TrackEndEvent
  | TrackExceptionEvent
  | TrackStuckEvent
  | WebSocketClosedEvent;

// ==================== REST API Types ====================

export interface UpdatePlayerPayload {
  track?: {
    encoded?: string | null;
    identifier?: string;
    userData?: Record<string, unknown>;
  };
  encodedTrack?: string | null;
  identifier?: string;
  position?: number;
  endTime?: number;
  volume?: number;
  paused?: boolean;
  filters?: FilterOptions;
  voice?: VoiceState;
}

export interface PlayerResponse {
  guildId: string;
  track: Track | null;
  volume: number;
  paused: boolean;
  state: PlayerState;
  voice: VoiceState;
  filters: FilterOptions;
}

// ==================== Manager Types ====================

export interface ManagerOptions {
  /** Array of Lavalink nodes */
  nodes: NodeOptions[];
  /** Function to send Discord gateway payloads */
  send: (guildId: string, payload: DiscordVoicePayload) => void;
  /** Bot client ID */
  clientId?: string;
  /** Number of shards */
  shards?: number;
  /** Auto-play next track in queue */
  autoPlay?: boolean;
  /** Default search platform */
  defaultSearchPlatform?: 'ytsearch' | 'ytmsearch' | 'scsearch' | 'spsearch' | 'amsearch';
  /** Enable debug logging */
  debug?: boolean;
  /** Maximum queue size per player (default: 1000) */
  maxQueueSize?: number;
  /** API rate limit delay in ms (default: 50) */
  apiRateLimitDelay?: number;
  /** Health check interval in ms (default: 60000) */
  healthCheckInterval?: number;
  /** Automatically move active players to another node when a node disconnects */
  autoMovePlayersOnNodeDisconnect?: boolean;
  /** DAVE readiness configuration (diagnostics/capability reporting) */
  dave?: Partial<DaveOptions>;
}

export interface DaveOptions {
  /** Enable DAVE readiness diagnostics */
  enabled: boolean;
  /** Maximum DAVE protocol version your Discord voice stack can negotiate */
  maxProtocolVersion: number;
  /** Minimum Lavalink version required for DAVE-ready operation */
  minLavalinkVersion: string;
}

export interface DaveNodeStatus {
  node: string;
  version: string;
  compatible: boolean;
  reason?: string;
}

export interface DaveReadinessReport {
  enabled: boolean;
  maxProtocolVersion: number;
  minLavalinkVersion: string;
  compatibleNodes: DaveNodeStatus[];
  incompatibleNodes: DaveNodeStatus[];
  summary: {
    connectedNodes: number;
    compatibleNodeCount: number;
    ready: boolean;
  };
}

export interface StartupNodeDiagnostic {
  name: string;
  connected: boolean;
  version: string;
  versionSource: 'info' | 'version' | 'unknown';
  infoAvailable: boolean;
  statsAvailable: boolean;
  error?: string;
}

export interface StartupDiagnosticReport {
  timestamp: number;
  totalNodes: number;
  connectedNodes: number;
  healthyNodes: number;
  nodes: StartupNodeDiagnostic[];
}

export interface DiscordVoicePayload {
  op: number;
  d: {
    guild_id: string;
    channel_id: string | null;
    self_mute: boolean;
    self_deaf: boolean;
  };
}

export interface DiscordVoiceServerUpdate {
  t: 'VOICE_SERVER_UPDATE';
  d: {
    token: string;
    guild_id: string;
    endpoint: string;
  };
}

export interface DiscordVoiceStateUpdate {
  t: 'VOICE_STATE_UPDATE';
  d: {
    guild_id: string;
    user_id: string;
    session_id: string;
    channel_id: string | null;
  };
}

export type DiscordVoiceEvent = DiscordVoiceServerUpdate | DiscordVoiceStateUpdate;

// ==================== Utility Types ====================

export interface SearchPlatform {
  ytsearch: 'ytsearch';
  ytmsearch: 'ytmsearch';
  scsearch: 'scsearch';
  spsearch: 'spsearch';
  amsearch: 'amsearch';
}

export type SearchPlatformType = keyof SearchPlatform;

export interface NodePenalty {
  /** Total penalty score */
  total: number;
  /** Breakdown of penalty components */
  breakdown: {
    players: number;
    playingPlayers: number;
    cpu: number;
    memory: number;
    nullFrames: number;
  };
}
