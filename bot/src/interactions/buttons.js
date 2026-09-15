import { MessageFlags } from 'discord.js';
import { replyWithLyrics } from '../commands/info.js';
import { startAutoplay } from '../music/autoplay.js';
import { clearFilters, toggleFilter } from '../music/filters.js';
import { getControllablePlayer, getPlayer, UserError } from '../music/guards.js';
import { create, edit, notice } from '../ui/components.js';
import { command } from '../ui/mentions.js';
import { renderClearConfirm, renderQueue } from '../ui/queue.js';
import { renderSound, VOLUME_STEP } from '../ui/sound.js';

const NEXT_LOOP = { off: 'queue', queue: 'track', track: 'off' };
const EPHEMERAL = { flags: MessageFlags.Ephemeral };

function ended() {
  return edit(notice('This player has ended', { note: `Start a new one with ${command('play')}.` }));
}

/** Re-render the panel the button was clicked on. */
async function updatePanel(interaction, bot, player) {
  const panel = player.data.get('panel');
  if (!panel || panel.messageId === interaction.message.id) {
    bot.panels.adopt(player, interaction.message);
    bot.panels.cancelRefresh(player);
    await interaction.update(edit(bot.panels.render(player)));
  } else {
    await interaction.update(edit(notice('This is an old player', { note: 'Use the newest player message in the chat.' })));
    bot.panels.refresh(player, 0);
  }
}

async function playerButton(interaction, bot, action) {
  const existing = bot.raya.getPlayer(interaction.guildId);
  if (!existing || existing.destroyed) return interaction.update(ended());

  if (action === 'sound') {
    const player = getPlayer(bot.raya, interaction);
    return interaction.reply(create(renderSound(player, { maxVolume: bot.config.player.maxVolume }), { ephemeral: true }));
  }
  if (action === 'queue') {
    return interaction.reply(create(renderQueue(getPlayer(bot.raya, interaction), 0), { ephemeral: true }));
  }
  if (action === 'lyrics') return replyWithLyrics(interaction, getPlayer(bot.raya, interaction));

  const player = getControllablePlayer(bot.raya, interaction);
  switch (action) {
    case 'toggle': {
      if (!player.current) throw new UserError('Nothing is playing right now.');
      await player.pause(!player.paused);
      if (!player.paused) player.data.delete('emptySince');
      return updatePanel(interaction, bot, player);
    }
    case 'skip':
      await interaction.deferUpdate();
      await player.skip();
      return;
    case 'previous':
    case 'replay': {
      await interaction.deferUpdate();
      const track = await player.previous();
      if (!track) await interaction.followUp({ ...create(notice('There is no previous song.'), { ephemeral: true }) });
      return;
    }
    case 'shuffle':
      player.queue.shuffle();
      return updatePanel(interaction, bot, player);
    case 'loop':
      player.setLoop(NEXT_LOOP[player.loop]);
      return updatePanel(interaction, bot, player);
    case 'autoplay': {
      player.setAutoplay(!player.autoplay);
      if (!player.autoplay || player.current) return updatePanel(interaction, bot, player);
      await interaction.deferUpdate();
      const started = await startAutoplay(player);
      if (!started) {
        bot.panels.refresh(player, 0);
        await interaction.followUp(create(notice("Couldn't find a related song to play."), { ephemeral: true }));
      }
      return;
    }
    case 'stop':
    case 'leave':
      player.data.set('stoppedBy', interaction.user.id);
      await interaction.deferUpdate();
      await player.destroy({ reason: 'stopped' });
      return;
    default:
      return interaction.reply({ ...EPHEMERAL, content: 'Unknown button.' });
  }
}

async function soundButton(interaction, bot, action, value) {
  const existing = bot.raya.getPlayer(interaction.guildId);
  if (!existing || existing.destroyed) return interaction.update(edit(notice('Nothing is playing anymore.')));
  const player = getControllablePlayer(bot.raya, interaction);
  const { maxVolume } = bot.config.player;

  if (action === 'volume') {
    const target = value === 'reset' ? 100 : player.volume + (value === 'up' ? VOLUME_STEP : -VOLUME_STEP);
    await player.setVolume(Math.max(0, Math.min(maxVolume, target)));
  } else if (action === 'filter') {
    await toggleFilter(player, value);
  } else if (action === 'clear') {
    await clearFilters(player);
  }
  bot.panels.refresh(player);
  return interaction.update(edit(renderSound(player, { maxVolume })));
}

async function queueButton(interaction, bot, action, value) {
  const existing = bot.raya.getPlayer(interaction.guildId);
  if (!existing || existing.destroyed) return interaction.update(edit(notice('Nothing is playing anymore.')));
  const page = Number.parseInt(value, 10) || 0;

  switch (action) {
    case 'page':
      return interaction.update(edit(renderQueue(existing, page)));
    case 'shuffle': {
      const player = getControllablePlayer(bot.raya, interaction);
      player.queue.shuffle();
      return interaction.update(edit(renderQueue(player, page)));
    }
    case 'clear':
      getControllablePlayer(bot.raya, interaction);
      return interaction.update(edit(renderClearConfirm(existing, page)));
    case 'clear-confirm': {
      const player = getControllablePlayer(bot.raya, interaction);
      player.queue.clear();
      return interaction.update(edit(renderQueue(player, 0)));
    }
    default:
      return interaction.reply({ ...EPHEMERAL, content: 'Unknown button.' });
  }
}

/** Routes `scope:action:value` button ids. */
export function handleButton(interaction, bot) {
  const [scope, action, value] = interaction.customId.split(':');
  if (scope === 'player') return playerButton(interaction, bot, action);
  if (scope === 'sound') return soundButton(interaction, bot, action, value);
  if (scope === 'queue') return queueButton(interaction, bot, action, value);
  return null;
}
