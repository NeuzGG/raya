/**
 * lavaflow - Professional-grade Lavalink v4 client library
 * Main entry point for the library
 */

// Core Manager
export { Manager } from './manager/Manager';

// Event System
export { LavalinkEventEmitter, Events } from './manager/events';
export type { ManagerEvents, TrackException } from './manager/events';

// Voice Management
export { VoiceForwarder } from './manager/VoiceForwarder';
export type { VoiceConnection } from './manager/VoiceForwarder';

// Node Management
export { Node, NodeState } from './nodes/Node';
export type { NodeEventHandlers } from './nodes/Node';
export { NodeManager, getNodeManager } from './nodes/NodeManager';
export type { PenaltyCalculator } from './nodes/NodeManager';

// Player
export { Player } from './player/Player';
export type { PlayerState } from './player/Player';

// Filters
export { FilterBuilder, EqualizerPresets } from './player/FilterBuilder';

// Utilities
export { HttpClient } from './utils/http';
export type { RequestOptions, RequestConfig } from './utils/http';
export { ExponentialBackoff, sleep, withBackoff } from './utils/backoff';
export type { BackoffOptions } from './utils/backoff';
export { AutoPlay } from './utils/autoplay';
export { MetadataCache } from './utils/MetadataCache';
export { FavoritesManager } from './utils/FavoritesManager';

// Types
export type {
  // Core Node Types
  NodeOptions,
  NodeStats,
  NodeInfo,
  
  // Track & Search Types
  Track,
  TrackInfo,
  Playlist,
  PlaylistInfo,
  LoadResult,
  LoadResultTrack,
  LoadResultPlaylist,
  LoadResultSearch,
  LoadResultEmpty,
  LoadResultError,
  
  // Player Types
  PlayerOptions,
  PlayerUpdateOptions,
  VoiceState,
  
  // Filter Types
  FilterOptions,
  EqualizerBand,
  KaraokeFilter,
  TimescaleFilter,
  TremoloFilter,
  VibratoFilter,
  RotationFilter,
  DistortionFilter,
  ChannelMixFilter,
  LowPassFilter,
  
  // WebSocket Event Types
  ReadyEvent,
  PlayerUpdateEvent,
  StatsEvent,
  TrackStartEvent,
  TrackEndEvent,
  TrackEndReason,
  TrackExceptionEvent,
  TrackStuckEvent,
  WebSocketClosedEvent,
  LavalinkEvent,
  
  // REST API Types
  UpdatePlayerPayload,
  PlayerResponse,
  
  // Manager Types
  ManagerOptions,
  DaveOptions,
  DaveNodeStatus,
  DaveReadinessReport,
  StartupNodeDiagnostic,
  StartupDiagnosticReport,
  DiscordVoicePayload,
  DiscordVoiceServerUpdate,
  DiscordVoiceStateUpdate,
  DiscordVoiceEvent,
  
  // Utility Types
  SearchPlatform,
  SearchPlatformType,
  NodePenalty,
} from './types/lavalink';

// Version
export const VERSION = '3.1.0';

// Re-export Manager as default
import { Manager as ManagerClass } from './manager/Manager';
export default ManagerClass;
