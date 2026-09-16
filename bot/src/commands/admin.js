import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { assertCanJoin, memberVoiceChannel, UserError } from '../music/guards.js';
import { create, notice } from '../ui/components.js';
import { command } from '../ui/mentions.js';

/** Commands only members who can manage the server see, hidden by Discord itself. */
const reset = {
  data: new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Force the player to stop and leave, even if it is stuck')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async run({ interaction, bot }) {
    const player = bot.raya.getPlayer(interaction.guildId);
    if (!player || player.destroyed) throw new UserError(`Nothing to reset. Start the music with ${command('play')}.`);
    player.data.set('stoppedBy', interaction.user.id);
    await player.destroy({ reason: 'stopped' });
    await interaction.reply(create(notice('Reset the player', { note: 'Everything was cleared and I left the voice channel.' })));
  },
};

const summon = {
  data: new SlashCommandBuilder()
    .setName('summon')
    .setDescription('Move the bot to your voice channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async run({ interaction, bot }) {
    const channel = memberVoiceChannel(interaction);
    if (!channel) throw new UserError('Join a voice channel first.');
    const player = bot.raya.getPlayer(interaction.guildId);
    if (!player || player.destroyed) throw new UserError(`Nothing is playing. Start with ${command('play')}.`);
    if (player.voiceChannelId === channel.id) throw new UserError(`I'm already in <#${channel.id}>.`);
    assertCanJoin(channel);
    await player.moveTo(channel.id);
    player.setTextChannel(interaction.channelId);
    bot.panels.refresh(player);
    await interaction.reply(create(notice(`Moved to <#${channel.id}>`)));
  },
};

export default [reset, summon];
