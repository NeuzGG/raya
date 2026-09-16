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

/** Someone who can manage the server can always control the music. */
export function isManager(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

/** Whether the member actually carries the server's DJ role. */
export function hasDJRole(bot, interaction) {
  const roleId = bot.settings?.get(interaction.guildId)?.djRoleId;
  if (!roleId) return false;
  const roles = interaction.member?.roles;
  return Boolean(Array.isArray(roles) ? roles.includes(roleId) : roles?.cache?.has(roleId));
}

/** Whether the member may run the disruptive commands: a DJ, a manager, or anyone when no DJ role is set. */
export function isDJ(bot, interaction) {
  if (isManager(interaction) || hasDJRole(bot, interaction)) return true;
  return !bot.settings?.get(interaction.guildId)?.djRoleId;
}

/**
 * With `/setup`, music commands belong in the request channel. DJs and managers may use them
 * anywhere, so they can fix things from a staff channel.
 */
export function assertMusicChannel(bot, interaction) {
  const setup = bot.settings?.setup(interaction.guildId);
  if (!setup?.textChannelId || interaction.channelId === setup.textChannelId) return;
  if (isManager(interaction) || hasDJRole(bot, interaction)) return;
  throw new UserError(`Use <#${setup.textChannelId}> for music commands.`);
}

export function getPlayer(bot, interaction) {
  const player = bot.raya.getPlayer(interaction.guildId);
  if (!player || player.destroyed) throw new UserError(`Nothing is playing. Start with ${command('play')}.`);
  return player;
}

/**
 * The server's player, if the member may change what everyone hears: they're in the same voice
 * channel, they're a DJ when a DJ role is set, or they can manage the server.
 */
export function getControllablePlayer(bot, interaction, { needsTrack = false } = {}) {
  const player = getPlayer(bot, interaction);
  const manager = isManager(interaction);
  if (!manager && !isDJ(bot, interaction)) {
    const roleId = bot.settings?.get(interaction.guildId)?.djRoleId;
    throw new UserError(`Only <@&${roleId}> can change the music right now.`);
  }
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
