import { SlashCommandBuilder } from 'discord.js';
import { startAutoplay } from '../music/autoplay.js';
import { getControllablePlayer, getPlayer, UserError } from '../music/guards.js';
import { create, edit, notice } from '../ui/components.js';
import { plural, trackLink } from '../ui/format.js';
import { renderQueue } from '../ui/queue.js';
import { queuePositionAutocomplete } from './shared.js';

const queue = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('See and manage the queue')
    .addIntegerOption((option) => option.setName('page').setDescription('Page to open').setMinValue(1)),
  async run({ interaction, bot }) {
    const player = getPlayer(bot, interaction);
    const page = (interaction.options.getInteger('page') ?? 1) - 1;
    await interaction.reply(create(renderQueue(player, page)));
  },
};

const remove = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a song from the queue')
    .addIntegerOption((option) =>
      option.setName('position').setDescription('The song to remove').setRequired(true).setMinValue(1).setAutocomplete(true),
    ),
  autocomplete: queuePositionAutocomplete,
  async run({ interaction, bot }) {
    const player = getControllablePlayer(bot, interaction);
    const position = interaction.options.getInteger('position', true);
    const removed = player.queue.remove(position - 1);
    if (!removed) throw new UserError(`There's no song at #${position}. The queue has ${plural(player.queue.size, 'song')}.`);
    await interaction.reply(create(notice(`Removed ${trackLink(removed, 70)} from the queue`)));
  },
};

const move = {
  data: new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move a song to another place in the queue')
    .addIntegerOption((option) =>
      option.setName('from').setDescription('The song to move').setRequired(true).setMinValue(1).setAutocomplete(true),
    )
    .addIntegerOption((option) => option.setName('to').setDescription('Its new position (1 plays next)').setRequired(true).setMinValue(1)),
  autocomplete: queuePositionAutocomplete,
  async run({ interaction, bot }) {
    const player = getControllablePlayer(bot, interaction);
    const from = interaction.options.getInteger('from', true);
    const to = Math.min(interaction.options.getInteger('to', true), player.queue.size);
    const track = player.queue.at(from - 1);
    if (!track) throw new UserError(`There's no song at #${from}. The queue has ${plural(player.queue.size, 'song')}.`);
    player.queue.move(from - 1, to - 1);
    await interaction.reply(create(notice(`Moved ${trackLink(track, 70)} to #${to}`)));
  },
};

const shuffle = {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
  async run({ interaction, bot }) {
    const player = getControllablePlayer(bot, interaction);
    if (player.queue.size < 2) throw new UserError('Add at least two songs to the queue to shuffle it.');
    player.queue.shuffle();
    await interaction.reply(create(notice(`Shuffled ${plural(player.queue.size, 'song')}`)));
  },
};

const LOOP_MESSAGES = {
  off: 'Loop is off',
  queue: 'Looping the queue',
  track: 'Repeating this song',
};
const NEXT_LOOP = { off: 'queue', queue: 'track', track: 'off' };

const loop = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Loop the current song or the whole queue')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Leave empty to switch to the next mode')
        .addChoices({ name: 'Off', value: 'off' }, { name: 'Queue', value: 'queue' }, { name: 'Song', value: 'track' }),
    ),
  async run({ interaction, bot }) {
    const player = getControllablePlayer(bot, interaction);
    const mode = interaction.options.getString('mode') ?? NEXT_LOOP[player.loop];
    player.setLoop(mode);
    bot.panels.refresh(player);
    await interaction.reply(create(notice(LOOP_MESSAGES[mode])));
  },
};

const autoplay = {
  data: new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('Keep playing related songs when the queue ends')
    .addBooleanOption((option) => option.setName('enabled').setDescription('Leave empty to toggle')),
  async run({ interaction, bot }) {
    const player = getControllablePlayer(bot, interaction);
    const enabled = interaction.options.getBoolean('enabled') ?? !player.autoplay;
    player.setAutoplay(enabled);
    bot.panels.refresh(player);
    if (!enabled) {
      await interaction.reply(create(notice('Autoplay is off')));
      return;
    }
    await interaction.deferReply();
    const started = player.current ? null : await startAutoplay(player);
    await interaction.editReply(
      edit(notice(started ? `Autoplay is on · playing ${trackLink(started, 60)}` : 'Autoplay is on', {
        note: "When the queue ends, I'll keep playing related songs.",
      })),
    );
  },
};

export default [queue, remove, move, shuffle, loop, autoplay];
