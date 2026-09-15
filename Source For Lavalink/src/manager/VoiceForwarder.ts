/**
 * VoiceForwarder - Handles Discord voice state updates
 * Intercepts VOICE_SERVER_UPDATE and VOICE_STATE_UPDATE events
 * and forwards them to the appropriate Lavalink node
 */

import type {
  DiscordVoiceEvent,
  DiscordVoiceServerUpdate,
  DiscordVoiceStateUpdate,
  DiscordVoicePayload,
  VoiceState,
} from '../types/lavalink';
import type { Player } from '../player/Player';
import type { LavalinkEventEmitter } from './events';

export interface VoiceConnection {
  guildId: string;
  channelId: string | null;
  sessionId?: string;
  token?: string;
  endpoint?: string;
}

export class VoiceForwarder {
  private voiceStates: Map<string, VoiceConnection> = new Map();
  private eventEmitter: LavalinkEventEmitter;
  private sendPayload: (guildId: string, payload: DiscordVoicePayload) => void;
  private clientId: string;

  constructor(
    clientId: string,
    sendPayload: (guildId: string, payload: DiscordVoicePayload) => void,
    eventEmitter: LavalinkEventEmitter
  ) {
    this.clientId = clientId;
    this.sendPayload = sendPayload;
    this.eventEmitter = eventEmitter;
  }

  /**
   * Process voice state updates from Discord
   */
  public async handleVoiceUpdate(packet: DiscordVoiceEvent, player?: Player): Promise<void> {
    if (packet.t === 'VOICE_SERVER_UPDATE') {
      await this.handleVoiceServerUpdate(packet, player);
    } else if (packet.t === 'VOICE_STATE_UPDATE') {
      await this.handleVoiceStateUpdate(packet, player);
    }
  }

  /**
   * Handle VOICE_SERVER_UPDATE from Discord
   */
  private async handleVoiceServerUpdate(
    packet: DiscordVoiceServerUpdate,
    player?: Player
  ): Promise<void> {
    const { guild_id, token, endpoint } = packet.d;

    this.eventEmitter.emit('debug', `Voice server update for guild ${guild_id}`);

    // Get or create voice connection state
    let voiceState = this.voiceStates.get(guild_id);
    if (!voiceState) {
      voiceState = {
        guildId: guild_id,
        channelId: null,
      };
      this.voiceStates.set(guild_id, voiceState);
    }

    // Update token and endpoint
    voiceState.token = token;
    voiceState.endpoint = endpoint ? this.normalizeEndpoint(endpoint) : undefined;

    // If we have complete voice state, forward to Lavalink
    if (player && voiceState.sessionId) {
      await this.forwardVoiceState(player, voiceState);
    }
  }

  /**
   * Handle VOICE_STATE_UPDATE from Discord
   */
  private async handleVoiceStateUpdate(
    packet: DiscordVoiceStateUpdate,
    player?: Player
  ): Promise<void> {
    const { guild_id, user_id, session_id, channel_id } = packet.d;

    // Only process updates for our bot
    if (user_id !== this.clientId) {
      return;
    }

    this.eventEmitter.emit('debug', `Voice state update for guild ${guild_id}`);

    // Get or create voice connection state
    let voiceState = this.voiceStates.get(guild_id);
    if (!voiceState) {
      voiceState = {
        guildId: guild_id,
        channelId: channel_id,
      };
      this.voiceStates.set(guild_id, voiceState);
    }

    // Update session ID and channel
    voiceState.sessionId = session_id;
    voiceState.channelId = channel_id;

    // If bot left the voice channel, clean up
    if (!channel_id) {
      this.voiceStates.delete(guild_id);
      if (player) {
        await player.disconnect();
      }
      return;
    }

    // If player moved to a different channel
    if (player && player.voiceChannelId !== channel_id) {
      const oldChannel = player.voiceChannelId;
      this.eventEmitter.emit('playerMove', player, oldChannel, channel_id);
    }

    // If we have complete voice state, forward to Lavalink
    if (player && voiceState.token && voiceState.endpoint) {
      await this.forwardVoiceState(player, voiceState);
    }
  }

  /**
   * Forward complete voice state to Lavalink
   */
  private async forwardVoiceState(
    player: Player,
    voiceState: VoiceConnection
  ): Promise<void> {
    const channelId = voiceState.channelId ?? player.voiceChannelId;

    if (!voiceState.sessionId || !voiceState.token || !voiceState.endpoint || !channelId) {
      this.eventEmitter.emit('debug', `Invalid voice state for guild ${player.guildId}: missing session, token, endpoint, or channelId`);
      return;
    }

    let lavalinkVoiceState: VoiceState = {
      token: voiceState.token,
      endpoint: voiceState.endpoint,
      sessionId: voiceState.sessionId,
      channelId,
    };

    try {
      await player.updateVoiceState(lavalinkVoiceState);
      this.eventEmitter.emit(
        'debug',
        `Forwarded voice state to Lavalink for guild ${player.guildId}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Some Lavalink deployments reject endpoint values with explicit port (e.g. :443).
      // Retry once with hostname-only endpoint when we receive HTTP 400.
      const retryEndpoint = lavalinkVoiceState.endpoint.replace(/:\d+$/, '');
      const shouldRetry =
        message.includes('HTTP 400') && retryEndpoint !== lavalinkVoiceState.endpoint;

      if (shouldRetry) {
        try {
          lavalinkVoiceState = {
            ...lavalinkVoiceState,
            endpoint: retryEndpoint,
          };
          await player.updateVoiceState(lavalinkVoiceState);
          this.eventEmitter.emit(
            'debug',
            `Forwarded voice state to Lavalink after endpoint retry for guild ${player.guildId}`
          );
          return;
        } catch (retryError) {
          this.eventEmitter.emit(
            'debug',
            `Voice endpoint retry failed for guild ${player.guildId}: ${retryError instanceof Error ? retryError.message : 'Unknown error'}`
          );
        }
      }

      this.eventEmitter.emit(
        'debug',
        `Error forwarding voice state for guild ${player.guildId}: ${message}`
      );
      return;
    }
  }

  /**
   * Normalize Discord voice endpoint for Lavalink.
   * Lavalink expects hostname[:port] without protocol prefix.
   */
  private normalizeEndpoint(endpoint: string): string {
    const cleaned = endpoint
      .trim()
      .replace(/^wss?:\/\//i, '')
      .replace(/\/$/, '')
      .replace(/\?.*$/, '')
      .replace(/\/.*$/, '');

    // Prefer hostname-only format for Lavalink compatibility.
    return cleaned.replace(/:443$/, '').replace(/:80$/, '');
  }

  /**
   * Send voice state update to Discord
   */
  public sendVoiceUpdate(
    guildId: string,
    channelId: string | null,
    options?: {
      selfMute?: boolean;
      selfDeaf?: boolean;
    }
  ): void {
    const payload: DiscordVoicePayload = {
      op: 4, // VOICE_STATE_UPDATE opcode
      d: {
        guild_id: guildId,
        channel_id: channelId,
        self_mute: options?.selfMute ?? false,
        self_deaf: options?.selfDeaf ?? false,
      },
    };

    this.sendPayload(guildId, payload);
    this.eventEmitter.emit(
      'debug',
      `Sent voice update to Discord for guild ${guildId}, channel ${channelId}`
    );
  }

  /**
   * Get voice connection state for a guild
   */
  public getVoiceState(guildId: string): VoiceConnection | undefined {
    return this.voiceStates.get(guildId);
  }

  /**
   * Clear voice state for a guild
   */
  public clearVoiceState(guildId: string): void {
    this.voiceStates.delete(guildId);
  }

  /**
   * Clear all voice states
   */
  public clearAllVoiceStates(): void {
    this.voiceStates.clear();
  }

  /**
   * Get all voice states
   */
  public getAllVoiceStates(): Map<string, VoiceConnection> {
    return new Map(this.voiceStates);
  }
}
