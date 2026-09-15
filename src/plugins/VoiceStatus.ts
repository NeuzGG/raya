import type { Raya } from '../Raya';
import type { Player } from '../player/Player';
import type { TrackEndReason } from '../types/lavalink';
import type { RayaPlugin, Track } from '../types/raya';
import { RayaError } from '../utils/errors';
import { sleep } from '../utils/backoff';
import { VERSION } from '../version';

/** A template string with placeholders, or a function returning the status text. */
export type VoiceStatusTemplate = string | ((track: Track, player: Player) => string);

export interface VoiceStatusOptions {
  /**
   * Status text. Placeholders: `{title}` `{author}` `{uri}` `{source}` `{duration}` `{requester}` `{identifier}`.
   * Default: `'Now playing: {title}'`
   */
  template?: VoiceStatusTemplate;
  /** Bot token. Default: read from the connector's client (discord.js, Eris, Oceanic). */
  token?: string;
  /** Clear the status when the queue ends, playback stops or the player is destroyed. Default: true */
  clearOnEnd?: boolean;
  /** Audit log reason sent with every update */
  reason?: string;
  /** Default: 'https://discord.com/api/v10' */
  apiBase?: string;
  /** Called when Discord rejects an update, e.g. the bot lacks the "Set Voice Channel Status" permission. */
  onError?: (error: Error, channelId: string) => void;
}

interface ChannelState {
  desired: string;
  sent: string | null;
  run: Promise<void> | null;
}

/** Discord's limit for voice channel status text */
export const MAX_VOICE_STATUS_LENGTH = 500;

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function requesterName(requester: unknown): string {
  if (typeof requester === 'string') return requester;
  if (!requester || typeof requester !== 'object') return '';
  const r = requester as Record<string, unknown>;
  const name = r.globalName ?? r.username ?? r.name ?? r.tag ?? r.id;
  return typeof name === 'string' ? name : '';
}

/**
 * Shows the current track as the Discord voice channel status and clears it when playback ends.
 * Rapid track changes are coalesced so only the latest status is sent.
 *
 * Enable with `new Raya({ voiceStatus: { template: '🎶 {title} - {author}' } })`
 * or `await raya.use(new VoiceStatus({ ... }))`.
 */
export class VoiceStatus implements RayaPlugin {
  public readonly name = 'voice-status';

  private raya: Raya | null = null;
  private removeDestroyHook: (() => void) | null = null;
  private readonly template: VoiceStatusTemplate;
  private readonly clearOnEnd: boolean;
  private readonly apiBase: string;
  private readonly states = new Map<string, ChannelState>();
  /** guildId -> channel whose status we set */
  private readonly active = new Map<string, string>();

  constructor(private readonly options: VoiceStatusOptions = {}) {
    this.template = options.template ?? 'Now playing: {title}';
    this.clearOnEnd = options.clearOnEnd ?? true;
    this.apiBase = (options.apiBase ?? 'https://discord.com/api/v10').replace(/\/+$/, '');
  }

  public load(raya: Raya): void {
    this.raya = raya;
    raya.on('trackStart', this.onTrackStart);
    raya.on('trackEnd', this.onTrackEnd);
    raya.on('queueEnd', this.onQueueEnd);
    raya.on('playerMove', this.onPlayerMove);
    raya.on('playerDestroy', this.onPlayerDestroy);
    raya.on('playerResume', this.onPlayerResume);
    // Clear before the bot leaves: Discord only accepts status changes from a member of the channel.
    this.removeDestroyHook = raya._addDestroyHook((player) =>
      this.clearOnEnd ? this.clearGuild(player.guildId) : undefined,
    );
  }

  public unload(raya: Raya): void {
    this.removeDestroyHook?.();
    this.removeDestroyHook = null;
    raya.off('playerResume', this.onPlayerResume);
    raya.off('trackStart', this.onTrackStart);
    raya.off('trackEnd', this.onTrackEnd);
    raya.off('queueEnd', this.onQueueEnd);
    raya.off('playerMove', this.onPlayerMove);
    raya.off('playerDestroy', this.onPlayerDestroy);
    this.raya = null;
  }

  /** Render the status text for a track. */
  public format(track: Track, player: Player): string {
    if (typeof this.template === 'function') return this.template(track, player);
    const { info } = track;
    const values: Record<string, string> = {
      title: info.title,
      author: info.author,
      uri: info.uri ?? '',
      source: info.sourceName,
      identifier: info.identifier,
      duration: info.isStream ? 'LIVE' : formatDuration(info.length),
      requester: requesterName(track.requester),
    };
    return this.template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
  }

  /**
   * Set a voice channel status. Calls made while a request is in flight are merged, so only
   * the most recent text is sent next. Rejects if the final update fails.
   */
  public set(channelId: string, status: string): Promise<void> {
    const text = status.length > MAX_VOICE_STATUS_LENGTH ? `${status.slice(0, MAX_VOICE_STATUS_LENGTH - 1)}…` : status;
    let state = this.states.get(channelId);
    if (!state) {
      state = { desired: text, sent: null, run: null };
      this.states.set(channelId, state);
    }
    state.desired = text;
    if (!state.run) {
      const current = state;
      current.run = this.drain(channelId, current).finally(() => {
        current.run = null;
        if (current.desired === '' && current.sent === '' && this.states.get(channelId) === current) {
          this.states.delete(channelId);
        }
      });
    }
    return state.run ?? Promise.resolve();
  }

  /** Clear a voice channel status. */
  public clear(channelId: string): Promise<void> {
    return this.set(channelId, '');
  }

  // ==================== Events ====================

  private readonly onTrackStart = (player: Player, track: Track): void => {
    const channelId = player.voiceChannelId;
    if (!channelId) return;
    const previous = this.active.get(player.guildId);
    if (previous && previous !== channelId) this.quietly(previous, '');
    this.active.set(player.guildId, channelId);
    this.quietly(channelId, this.safeFormat(track, player));
  };

  private readonly onTrackEnd = (player: Player, _track: Track, reason: TrackEndReason): void => {
    if (this.clearOnEnd && reason === 'stopped' && !player.current) this.clearGuild(player.guildId);
  };

  private readonly onQueueEnd = (player: Player): void => {
    if (this.clearOnEnd) this.clearGuild(player.guildId);
  };

  private readonly onPlayerMove = (player: Player, oldChannelId: string | null, newChannelId: string | null): void => {
    const previous = this.active.get(player.guildId);
    if (previous && previous === oldChannelId) {
      this.active.delete(player.guildId);
      this.quietly(previous, '');
    }
    if (newChannelId && player.current) this.onTrackStart(player, player.current);
  };

  /** Restored or rebuilt players: make sure the status matches what is playing. Unchanged text is not re-sent. */
  private readonly onPlayerResume = (player: Player): void => {
    if (player.current) this.onTrackStart(player, player.current);
  };

  private readonly onPlayerDestroy = (player: Player): void => {
    if (this.clearOnEnd) this.clearGuild(player.guildId);
    else this.active.delete(player.guildId);
  };

  // ==================== Internals ====================

  private clearGuild(guildId: string): Promise<void> {
    const channelId = this.active.get(guildId);
    if (!channelId) return Promise.resolve();
    this.active.delete(guildId);
    return this.set(channelId, '').catch(() => undefined);
  }

  private safeFormat(track: Track, player: Player): string {
    try {
      return this.format(track, player);
    } catch (error) {
      this.report(error, player.voiceChannelId ?? '');
      return '';
    }
  }

  private quietly(channelId: string, status: string): void {
    this.set(channelId, status).catch(() => undefined);
  }

  private async drain(channelId: string, state: ChannelState): Promise<void> {
    let lastError: unknown = null;
    while (state.sent !== state.desired) {
      const status = state.desired;
      try {
        await this.put(channelId, status);
        lastError = null;
        this.raya?.debug(() => `[VoiceStatus] ${status ? `set "${status}"` : 'cleared'} on channel ${channelId}`);
      } catch (error) {
        lastError = error;
        this.report(error, channelId);
      }
      state.sent = status;
    }
    if (lastError) throw lastError;
  }

  private resolveToken(): string | null {
    const token = this.options.token ?? this.raya?.connector?.getToken?.() ?? null;
    return token ? token.replace(/^Bot\s+/i, '') : null;
  }

  private async put(channelId: string, status: string): Promise<void> {
    const token = this.resolveToken();
    if (!token) {
      throw new RayaError('INVALID_ARGUMENT', 'VoiceStatus needs a bot token: pass { token } or use a connector');
    }
    const headers: Record<string, string> = {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': `DiscordBot (https://github.com/neuzgg/raya, ${VERSION})`,
    };
    if (this.options.reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(this.options.reason);

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${this.apiBase}/channels/${channelId}/voice-status`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ status }),
          signal: AbortSignal.timeout(10000),
        });
      } catch (error) {
        throw new RayaError('NETWORK_ERROR', `Voice status request for channel ${channelId} failed`, { cause: error });
      }
      if (response.ok) return;

      const text = await response.text().catch(() => '');
      let body: { message?: string; retry_after?: number } = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      if (response.status === 429 && attempt < 3) {
        const retryAfter = Number(body.retry_after ?? response.headers.get('retry-after') ?? 1);
        await sleep(Math.max(0, retryAfter) * 1000);
        continue;
      }
      throw new RayaError(
        'DISCORD_API_ERROR',
        `Discord rejected the voice status for channel ${channelId} (HTTP ${response.status}): ${body.message ?? (text || response.statusText)}`,
      );
    }
  }

  private report(error: unknown, channelId: string): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.raya?.debug(() => `[VoiceStatus] ${err.message}`);
    this.options.onError?.(err, channelId);
  }
}
