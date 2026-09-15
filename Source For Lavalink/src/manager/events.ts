/**
 * Typed EventEmitter for Lavalink events
 * Provides type-safe event handling for the library
 */

import { EventEmitter } from 'events';
import type { Track, TrackEndReason, NodeStats } from '../types/lavalink';
import type { Player } from '../player/Player';
import type { Node } from '../nodes/Node';

export interface ManagerEvents {
  // Node events
  nodeConnect: [node: Node];
  nodeDisconnect: [node: Node, code: number, reason: string];
  nodeError: [node: Node, error: Error];
  nodeReconnect: [node: Node, attempt: number];
  nodeStats: [node: Node, stats: NodeStats];

  // Player events
  playerCreate: [player: Player];
  playerDestroy: [player: Player];
  playerMove: [player: Player, oldChannel: string, newChannel: string];
  playerNodeMigrate: [player: Player, fromNode: string, toNode: string];

  // Track events
  trackStart: [player: Player, track: Track];
  trackEnd: [player: Player, track: Track, reason: TrackEndReason];
  trackStuck: [player: Player, track: Track, thresholdMs: number];
  trackException: [player: Player, track: Track, exception: TrackException];

  // Queue events
  queueEnd: [player: Player];
  queueChanged: [{ action: string; track?: Track; count?: number; fromIndex?: number; toIndex?: number; indexA?: number; indexB?: number; index?: number; queueLength: number }];

  // WebSocket events
  socketClosed: [player: Player, code: number, reason: string, byRemote: boolean];

  // Debug events
  debug: [message: string];
}

export interface TrackException {
  message: string;
  severity: 'common' | 'suspicious' | 'fault';
  cause: string;
}

/**
 * Type-safe event emitter for manager events
 */
export class LavalinkEventEmitter extends EventEmitter {
  /**
   * Emit a typed event
   */
  public emit<K extends keyof ManagerEvents>(
    event: K,
    ...args: ManagerEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Listen to a typed event
   */
  public on<K extends keyof ManagerEvents>(
    event: K,
    listener: (...args: ManagerEvents[K]) => void
  ): this {
    return super.on(event, listener);
  }

  /**
   * Listen to a typed event once
   */
  public once<K extends keyof ManagerEvents>(
    event: K,
    listener: (...args: ManagerEvents[K]) => void
  ): this {
    return super.once(event, listener);
  }

  /**
   * Remove a typed event listener
   */
  public off<K extends keyof ManagerEvents>(
    event: K,
    listener: (...args: ManagerEvents[K]) => void
  ): this {
    return super.off(event, listener);
  }

  /**
   * Remove all listeners for an event
   */
  public removeAllListeners<K extends keyof ManagerEvents>(event?: K): this {
    return super.removeAllListeners(event);
  }
}

/**
 * Event names for external reference
 */
export const Events = {
  // Node events
  NodeConnect: 'nodeConnect' as const,
  NodeDisconnect: 'nodeDisconnect' as const,
  NodeError: 'nodeError' as const,
  NodeReconnect: 'nodeReconnect' as const,
  NodeStats: 'nodeStats' as const,

  // Player events
  PlayerCreate: 'playerCreate' as const,
  PlayerDestroy: 'playerDestroy' as const,
  PlayerMove: 'playerMove' as const,
  PlayerNodeMigrate: 'playerNodeMigrate' as const,

  // Track events
  TrackStart: 'trackStart' as const,
  TrackEnd: 'trackEnd' as const,
  TrackStuck: 'trackStuck' as const,
  TrackException: 'trackException' as const,

  // Queue events
  QueueEnd: 'queueEnd' as const,

  // WebSocket events
  SocketClosed: 'socketClosed' as const,

  // Debug events
  Debug: 'debug' as const,
} as const;
