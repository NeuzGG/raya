import type { LavalinkErrorResponse } from '../types/lavalink';

export type RayaErrorCode =
  | 'NOT_INITIALIZED'
  | 'ALREADY_INITIALIZED'
  | 'NO_NODES'
  | 'NODE_NOT_FOUND'
  | 'NODE_NOT_READY'
  | 'NODE_AUTH_FAILED'
  | 'NODE_EXISTS'
  | 'REST_ERROR'
  | 'REST_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'PLAYER_DESTROYED'
  | 'NO_TRACK'
  | 'QUEUE_FULL'
  | 'INVALID_ARGUMENT'
  | 'VOICE_TIMEOUT'
  | 'DECODE_FAILED'
  | 'DISCORD_API_ERROR';

/**
 * Every error thrown by Raya is a RayaError with a stable, switchable `code`.
 */
export class RayaError extends Error {
  public readonly code: RayaErrorCode;

  constructor(code: RayaErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RayaError';
    this.code = code;
  }
}

/**
 * Thrown when Lavalink answers a REST request with a non-2xx status.
 */
export class RestError extends RayaError {
  public readonly status: number;
  public readonly method: string;
  public readonly path: string;
  /** Parsed Lavalink error body, when available */
  public readonly body: LavalinkErrorResponse | null;

  constructor(method: string, path: string, status: number, body: LavalinkErrorResponse | null, rawText?: string) {
    const detail = body?.message ?? rawText ?? '';
    super('REST_ERROR', `${method} ${path} failed with HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'RestError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}
