import { length, truncate } from '../ui/format.js';

/** Suggests queue positions by number or title, e.g. for /skip to, /remove and /move. */
export async function queuePositionAutocomplete({ interaction, bot }) {
  const player = bot.raya.getPlayer(interaction.guildId);
  if (!player || player.destroyed || player.queue.isEmpty) return interaction.respond([]);
  const typed = String(interaction.options.getFocused() ?? '').trim().toLowerCase();
  const choices = [];
  let index = 0;
  for (const track of player.queue) {
    index++;
    const title = `${track.info.title} · ${track.info.author}`;
    if (!typed || String(index).startsWith(typed) || title.toLowerCase().includes(typed)) {
      choices.push({ name: truncate(`${index}. ${title} (${length(track)})`, 100), value: index });
      if (choices.length === 25) break;
    }
  }
  return interaction.respond(choices);
}
