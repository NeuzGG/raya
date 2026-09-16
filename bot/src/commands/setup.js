import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../music/guards.js';
import { create, edit, notice } from '../ui/components.js';
import { command } from '../ui/mentions.js';

const CATEGORY_NAME = 'Raya Music';
const TEXT_NAME = 'raya-requests';
const VOICE_NAME = 'Raya Music';
const TOPIC = 'Ask for songs here. The pinned player updates itself while the music plays.';

function setupSummary(bot, guildId) {
  const settings = bot.settings.get(guildId);
  const setup = settings.setup;
  const lines = [];
  if (setup?.textChannelId) lines.push(`Requests: <#${setup.textChannelId}>`);
  if (setup?.voiceChannelId) lines.push(`Voice: <#${setup.voiceChannelId}>`);
  lines.push(settings.djRoleId ? `DJ role: <@&${settings.djRoleId}>` : 'DJ role: anyone can control the music');
  return lines;
}

const setup = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create a music request channel with a live dashboard')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('create').setDescription('Create the category, request channel and voice channel'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Show the current setup'))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Stop using the request channel (the channels stay)')),

  async run({ interaction, bot }) {
    const action = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const existing = bot.settings.setup(interaction.guildId);

    if (action === 'status') {
      if (!existing) {
        throw new UserError(`This server has no music channel yet. Create one with ${command('setup create')}.`);
      }
      await bot.panels.refreshDashboard(interaction.guildId);
      await interaction.reply(
        create(notice('Music channel is set up', { note: setupSummary(bot, interaction.guildId).join(' · ') }), { ephemeral: true }),
      );
      return;
    }

    if (action === 'disable') {
      if (!existing) throw new UserError('This server has no music channel to turn off.');
      bot.settings.update(interaction.guildId, { setup: null });
      await interaction.reply(
        create(
          notice('Music commands work everywhere again', {
            note: `The channels are still there: delete <#${existing.textChannelId}> and its category if you don't want them.`,
          }),
          { ephemeral: true },
        ),
      );
      return;
    }

    if (existing?.textChannelId && guild.channels.cache.has(existing.textChannelId)) {
      await bot.panels.refreshDashboard(interaction.guildId);
      await interaction.reply(
        create(
          notice(`Already set up in <#${existing.textChannelId}>`, {
            note: `The dashboard has been refreshed. Turn it off with ${command('setup disable')}.`,
          }),
          { ephemeral: true },
        ),
      );
      return;
    }

    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new UserError('I need the **Manage Channels** permission to create the music channels.');
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
          note: `Ask for songs there and watch the dashboard. ${setupSummary(bot, interaction.guildId).join(' · ')}`,
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
      await bot.panels.refreshDashboard(interaction.guildId);
      await interaction.reply(create(notice('Cleared the DJ role', { note: 'Anyone in the voice channel can control the music again.' })));
      return;
    }

    const role = interaction.options.getRole('role', true);
    bot.settings.update(interaction.guildId, { djRoleId: role.id });
    await bot.panels.refreshDashboard(interaction.guildId);
    await interaction.reply(
      create(
        notice(`DJ role set to <@&${role.id}>`, {
          note: 'Everyone can still add songs; only DJs and server managers can skip, stop or change the sound.',
        }),
      ),
    );
  },
};

export default [setup, dj];
