import { helpView } from '../commands/info.js';
import { getControllablePlayer, isManager } from '../music/guards.js';
import { button, create, edit, notice, row } from '../ui/components.js';
import { emojis } from '../ui/emojis.js';
import { command } from '../ui/mentions.js';
import { renderHelp } from '../ui/info.js';
import { clampPage, jumpedNote, renderQueue } from '../ui/queue.js';

/** The /help category dropdown. Only the person who ran the command can change it. */
async function helpSelect(interaction, bot, ownerId) {
  if (interaction.user.id !== ownerId) {
    return interaction.reply(
      create(notice('This menu belongs to someone else', { note: `Run ${command('help')} for your own.` }), { ephemeral: true }),
    );
  }
  const view = helpView(bot, {
    categoryId: interaction.values[0],
    isAdmin: isManager(interaction),
    viewerId: ownerId,
  });
  return interaction.update(edit(renderHelp(view)));
}

/** Jump to a song from the queue dropdown. */
async function queueJump(interaction, bot, value) {
  const existing = bot.raya.getPlayer(interaction.guildId);
  if (!existing || existing.destroyed) return interaction.update(edit(notice('Nothing is playing anymore.')));
  const player = getControllablePlayer(bot, interaction);

  const position = Number.parseInt(interaction.values[0], 10);
  const target = player.queue.at(position - 1);
  if (!target) return interaction.update(edit(renderQueue(player, clampPage(player, Number.parseInt(value, 10)))));

  await player.skip(position);
  bot.panels.refresh(player, 0);
  return interaction.update(
    edit(
      notice(jumpedNote(target, position - 1), {
        rows: [row(button('queue:page:0', { emoji: emojis.queue, label: 'Back to the queue' }))],
      }),
    ),
  );
}

/** Routes `scope:action:value` dropdown ids. */
export function handleSelect(interaction, bot) {
  const [scope, action, value] = interaction.customId.split(':');
  if (scope === 'help') return helpSelect(interaction, bot, action);
  if (scope === 'queue' && action === 'jump') return queueJump(interaction, bot, value);
  return null;
}
