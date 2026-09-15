import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { VERSION } from 'raya.js';
import { getPlayer, UserError } from '../music/guards.js';
import { create, edit, notice } from '../ui/components.js';
import { trackLink } from '../ui/format.js';
import { renderHelp, renderLyrics } from '../ui/info.js';
import { hasLyrics } from '../ui/panel.js';

/** Fetch lyrics for the current song and answer with an ephemeral card. Shared with the Lyrics button. */
export async function replyWithLyrics(interaction, player) {
  const track = player.current;
  if (!track) throw new UserError('Nothing is playing right now.');
  if (!hasLyrics(player)) throw new UserError("Lyrics aren't available on this music server.");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const lyrics = await player.getLyrics().catch((error) => {
    if (error?.status === 404) return null;
    throw error;
  });
  const hasText = lyrics && (lyrics.text?.trim() || lyrics.lines?.length);
  await interaction.editReply(
    edit(hasText ? renderLyrics(track, lyrics) : notice(`No lyrics found for ${trackLink(track, 70)}`)),
  );
}

const lyrics = {
  data: new SlashCommandBuilder().setName('lyrics').setDescription('Lyrics of the current song'),
  async run({ interaction, bot }) {
    await replyWithLyrics(interaction, getPlayer(bot.raya, interaction));
  },
};

export function helpStats(bot) {
  const ping = bot.raya.readyNodes.reduce((best, node) => (node.ping >= 0 && (best === null || node.ping < best) ? node.ping : best), null);
  return {
    servers: bot.client.guilds.cache.size,
    playing: bot.raya.stats.playingPlayers,
    ping,
    version: VERSION,
    links: { ...bot.config.links, invite: bot.invite() },
  };
}

const help = {
  data: new SlashCommandBuilder().setName('help').setDescription('How to use Raya'),
  async run({ interaction, bot }) {
    await interaction.reply(create(renderHelp(helpStats(bot)), { ephemeral: true }));
  },
};

export default [lyrics, help];
