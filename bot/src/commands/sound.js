import { SlashCommandBuilder } from 'discord.js';
import { FILTERS, clearFilters, setFilter } from '../music/filters.js';
import { getControllablePlayer, getPlayer } from '../music/guards.js';
import { create, notice } from '../ui/components.js';
import { renderSound } from '../ui/sound.js';

const volume = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Change the volume')
    .addIntegerOption((option) =>
      option.setName('level').setDescription('0 to 200, where 100 is normal. Leave empty to open the sound board').setMinValue(0).setMaxValue(200),
    ),
  async run({ interaction, bot }) {
    const level = interaction.options.getInteger('level');
    if (level === null) {
      const player = getPlayer(bot, interaction);
      await interaction.reply(create(renderSound(player, { maxVolume: bot.config.player.maxVolume }), { ephemeral: true }));
      return;
    }
    const player = getControllablePlayer(bot, interaction);
    await player.setVolume(Math.min(level, bot.config.player.maxVolume));
    bot.panels.refresh(player);
    await interaction.reply(create(notice(`Volume set to **${player.volume}%**`)));
  },
};

const filters = {
  data: new SlashCommandBuilder()
    .setName('filters')
    .setDescription('Bass boost, nightcore, 8D and more')
    .addStringOption((option) =>
      option
        .setName('preset')
        .setDescription('Turn a preset on (leave empty to open the sound board)')
        .addChoices(...FILTERS.map((filter) => ({ name: filter.label, value: filter.id })), { name: 'Clear all filters', value: 'clear' }),
    ),
  async run({ interaction, bot }) {
    const preset = interaction.options.getString('preset');
    if (preset === null) {
      const player = getPlayer(bot, interaction);
      await interaction.reply(create(renderSound(player, { maxVolume: bot.config.player.maxVolume }), { ephemeral: true }));
      return;
    }
    const player = getControllablePlayer(bot, interaction);
    if (preset === 'clear') {
      await clearFilters(player);
      bot.panels.refresh(player);
      await interaction.reply(create(notice('Cleared all filters')));
      return;
    }
    await setFilter(player, preset, true);
    bot.panels.refresh(player);
    const label = FILTERS.find((filter) => filter.id === preset).label;
    await interaction.reply(create(notice(`Turned on **${label}**`, { note: 'It can take a few seconds to kick in.' })));
  },
};

export default [volume, filters];
