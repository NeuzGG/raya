import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { command } from '../ui/mentions.js';

/** An error whose message is safe and meant to be shown to the user. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

/** The voice channel the member who used the interaction is in, or null. */
export function memberVoiceChannel(interaction) {
  return interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channel ?? null;
}

export function getPlayer(raya, interaction) {
  const player = raya.getPlayer(interaction.guildId);
  if (!player || player.destroyed) throw new UserError(`Nothing is playing. Start with ${command('play')}.`);
  return player;
}

/**
 * The guild's player, if the member may control it: they're in the same voice channel,
 * or they can manage the server.
 */
export function getControllablePlayer(raya, interaction, { needsTrack = false } = {}) {
  const player = getPlayer(raya, interaction);
  const manager = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  if (!manager && player.voiceChannelId && memberVoiceChannel(interaction)?.id !== player.voiceChannelId) {
    throw new UserError(`Join <#${player.voiceChannelId}> to control the music.`);
  }
  if (needsTrack && !player.current) throw new UserError(`Nothing is playing right now. Add songs with ${command('play')}.`);
  return player;
}

/** Checks that the bot can join and speak in a voice channel. */
export function assertCanJoin(channel) {
  const me = channel.guild.members.me;
  const permissions = me ? channel.permissionsFor(me) : null;
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
    throw new UserError(`I don't have permission to join <#${channel.id}>.`);
  }
  if (!permissions.has(PermissionFlagsBits.Speak) && channel.type !== ChannelType.GuildStageVoice) {
    throw new UserError(`I don't have permission to speak in <#${channel.id}>.`);
  }
  if (!channel.joinable) throw new UserError(`<#${channel.id}> is full.`);
}
