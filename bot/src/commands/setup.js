import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../music/guards.js';
import { button, ButtonStyle, create, edit, notice, row } from '../ui/components.js';
import { emojis } from '../ui/emojis.js';
import { command } from '../ui/mentions.js';

const CATEGORY_NAME = 'Raya Music';
const TEXT_NAME = 'raya-requests';
const VOICE_NAME = 'Raya Music';
const TOPIC = 'Send a song name or a link here to play it. The player above updates itself while the music plays.';

function setupSummary(bot, guildId) {
  const settings = bot.settings.get(guildId);
  const setup = settings.setup;
  const lines = [];
  if (setup?.textChannelId) lines.push(`Requests: <#${setup.textChannelId}>`);
  if (setup?.voiceChannelId) lines.push(`Voice: <#${setup.voiceChannelId}>`);
  lines.push(settings.djRoleId ? `DJ role: <@&${settings.djRoleId}>` : 'DJ role: anyone can control the music');
  return lines;
}

/** The channels /setup created, as far as we can still see them. */
export function setupChannels(bot, guildId) {
  const setup = bot.settings.setup(guildId);
  if (!setup) return [];
  return [setup.textChannelId, setup.voiceChannelId, setup.categoryId]
    .filter(Boolean)
    .map((id) => bot.client.channels.cache.get(id))
    .filter(Boolean);
}

const setup = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create a song request channel with a live dashboard')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('create').setDescription('Create the category, request channel and voice channel'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Show the current setup'))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Stop using the request channel (the channels stay)'))
    .addSubcommand((sub) => sub.setName('delete').setDescription('Delete the channels Raya created')),

  async run({ interaction, bot }) {
    // Answer Discord first: everything below can take longer than the three seconds it waits.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const action = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const existing = bot.settings.setup(interaction.guildId);

    if (action === 'status') {
      if (!existing) throw new UserError(`This server has no music channel yet. Create one with ${command('setup create')}.`);
      await bot.panels.refreshDashboard(interaction.guildId);
      await interaction.editReply(
        edit(notice('Music channel is set up', { note: setupSummary(bot, interaction.guildId).join(' · ') })),
      );
      return;
    }

    if (action === 'disable') {
      if (!existing) throw new UserError('This server has no music channel to turn off.');
      bot.settings.update(interaction.guildId, { setup: null });
      await interaction.editReply(
        edit(
          notice('Music commands work everywhere again', {
            note: `The channels are still there: delete them yourself, or run ${command('setup delete')}.`,
          }),
        ),
      );
      return;
    }

    if (action === 'delete') {
      if (!existing) throw new UserError('This server has no music channel to delete.');
      const names = setupChannels(bot, interaction.guildId).map((channel) => `**${channel.name}**`);
      await interaction.editReply(
        edit(
          notice(`Delete ${names.join(', ') || 'the channels Raya created'}?`, {
            note: 'Everything written in the request channel goes with them. This cannot be undone.',
            rows: [
              row(
                button('setup:delete', { emoji: emojis.clear, label: 'Delete the channels', style: ButtonStyle.Danger }),
                button('setup:keep', { label: 'Cancel' }),
              ),
            ],
          }),
        ),
      );
      return;
    }

    if (existing?.textChannelId && guild.channels.cache.has(existing.textChannelId)) {
      await bot.panels.refreshDashboard(interaction.guildId);
      await interaction.editReply(
        edit(
          notice(`Already set up in <#${existing.textChannelId}>`, {
            note: `The dashboard has been refreshed. Turn it off with ${command('setup disable')}.`,
          }),
        ),
      );
      return;
    }

    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new UserError('I need the **Manage Channels** permission to create the music channels.');
    }

    const category = await guild.channels.create({
      name: CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      reason: `Raya setup by ${interaction.user.tag ?? interaction.user.id}`,
    });
    const text = await guild.channels.create({
      name: TEXT_NAME,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: TOPIC,
      reason: 'Raya setup',
    });
    const voice = await guild.channels.create({
      name: VOICE_NAME,
      type: ChannelType.GuildVoice,
      parent: category.id,
      reason: 'Raya setup',
    });

    bot.settings.update(interaction.guildId, {
      setup: { categoryId: category.id, textChannelId: text.id, voiceChannelId: voice.id, messageId: null },
    });
    await bot.panels.refreshDashboard(interaction.guildId);

    await interaction.editReply(
      edit(
        notice(`Music channel ready: <#${text.id}>`, {
          note: bot.config.songRequests
            ? `People can send a song name or a link there, no command needed. ${setupSummary(bot, interaction.guildId).join(' · ')}`
            : `Songs are started with ${command('play')} there. ${setupSummary(bot, interaction.guildId).join(' · ')}`,
        }),
      ),
    );
  },
};

const dj = {
  data: new SlashCommandBuilder()
    .setName('dj')
    .setDescription('Choose who can skip, stop and change the sound')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Only this role (and server managers) may control the music')
        .addRoleOption((option) => option.setName('role').setDescription('The DJ role').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('clear').setDescription('Let everyone in the voice channel control the music'))
    .addSubcommand((sub) => sub.setName('show').setDescription('Show the current DJ role')),

  async run({ interaction, bot }) {
    const action = interaction.options.getSubcommand();
    const current = bot.settings.get(interaction.guildId).djRoleId;

    if (action === 'show') {
      await interaction.reply(
        create(
          notice(current ? `The DJ role is <@&${current}>` : 'There is no DJ role', {
            note: current
              ? 'Everyone can still add songs; only DJs and managers can skip, stop or change the sound.'
              : 'Anyone in the voice channel can control the music.',
          }),
          { ephemeral: true },
        ),
      );
      return;
    }

    if (action === 'clear') {
      if (!current) throw new UserError('There is no DJ role to clear.');
      bot.settings.update(interaction.guildId, { djRoleId: null });
      await interaction.reply(create(notice('Cleared the DJ role', { note: 'Anyone in the voice channel can control the music again.' })));
      await bot.panels.refreshDashboard(interaction.guildId);
      return;
    }

    const role = interaction.options.getRole('role', true);
    bot.settings.update(interaction.guildId, { djRoleId: role.id });
    await interaction.reply(
      create(
        notice(`DJ role set to <@&${role.id}>`, {
          note: 'Everyone can still add songs; only DJs and server managers can skip, stop or change the sound.',
        }),
      ),
    );
    await bot.panels.refreshDashboard(interaction.guildId);
  },
};

export default [setup, dj];
