import type { GatewayVoiceState } from '../types/lavalink';

interface GuildVoice {
  /** userId -> channelId */
  users: Map<string, string>;
  bots: Set<string>;
}

interface GuildCreateData {
  id?: string;
  unavailable?: boolean;
  voice_states?: Array<{ user_id: string; channel_id: string | null }>;
  members?: Array<{ user?: { id: string; bot?: boolean } }>;
}

/**
 * Tracks who is in which voice channel from raw gateway events, without any Discord library.
 * A guild is only tracked once its GUILD_CREATE was seen, so counts are never guessed from
 * partial data (which would make the bot leave channels that still have listeners).
 */
export class VoiceStateCache {
  private readonly guilds = new Map<string, GuildVoice>();

  public seed(data: GuildCreateData): void {
    if (!data?.id || data.unavailable) return;
    const guild: GuildVoice = { users: new Map(), bots: new Set() };
    for (const member of data.members ?? []) {
      if (member.user?.bot) guild.bots.add(member.user.id);
    }
    for (const state of data.voice_states ?? []) {
      if (state.channel_id) guild.users.set(state.user_id, state.channel_id);
    }
    this.guilds.set(data.id, guild);
  }

  public update(state: GatewayVoiceState): void {
    if (!state.guild_id) return;
    const guild = this.guilds.get(state.guild_id);
    if (!guild) return;
    if (state.member?.user?.bot) guild.bots.add(state.user_id);
    if (state.channel_id) guild.users.set(state.user_id, state.channel_id);
    else guild.users.delete(state.user_id);
  }

  public forget(guildId: string): void {
    this.guilds.delete(guildId);
  }

  public isTracked(guildId: string): boolean {
    return this.guilds.has(guildId);
  }

  /** Number of non-bot users in a channel, or null if the guild is not tracked. */
  public countHumans(guildId: string, channelId: string, selfId: string | null): number | null {
    const guild = this.guilds.get(guildId);
    if (!guild) return null;
    let count = 0;
    for (const [userId, userChannel] of guild.users) {
      if (userChannel === channelId && userId !== selfId && !guild.bots.has(userId)) count++;
    }
    return count;
  }
}
