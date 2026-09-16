import { MessageFlags, SlashCommandBuilder, version as discordVersion } from 'discord.js';
import { VERSION } from 'raya.js';
import { latestAnnouncement } from '../announcements.js';
import { categoryById, dropdownCategories, helpOverview, helpSections } from './catalog.js';
import { getPlayer, isManager, UserError } from '../music/guards.js';
import { create, edit, notice } from '../ui/components.js';
import { trackLink } from '../ui/format.js';
import { renderHelp, renderLyrics, renderStats } from '../ui/info.js';
import { hasLyrics } from '../ui/panel.js';

/**
 * Fetch lyrics for the current song and answer privately. Shared with the Lyrics button.
 * LavaLyrics answers 404 when it finds nothing and 500 when a provider fails, so neither
 * is reported as a bot error.
 */
export async function replyWithLyrics(interaction, player, log) {
  const track = player.current;
  if (!track) throw new UserError('Nothing is playing right now.');
  if (!hasLyrics(player)) throw new UserError("Lyrics aren't available on this music server.");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let lyrics = null;
  let failed = false;
  try {
    lyrics = await player.getLyrics();
  } catch (error) {
    if (error?.code !== 'REST_ERROR' && error?.code !== 'REST_TIMEOUT') throw error;
    failed = error.status !== 404;
    log?.debug(`lyrics for "${track.info.title}" failed: ${error.message}`);
  }

  const hasText = lyrics && (lyrics.text?.trim() || lyrics.lines?.length);
  if (hasText) {
    await interaction.editReply(edit(renderLyrics(track, lyrics)));
    return;
  }
  await interaction.editReply(
    edit(
      notice(`No lyrics for ${trackLink(track, 70)}`, {
        note: failed ? "The lyrics provider didn't answer. Try again in a moment." : 'Nothing was found for this song.',
      }),
    ),
  );
}

const lyrics = {
  data: new SlashCommandBuilder().setName('lyrics').setDescription('Lyrics of the current song'),
  async run({ interaction, bot }) {
    await replyWithLyrics(interaction, getPlayer(bot, interaction), bot.log);
  },
};

/** Everything the help card needs, for the command and for the category dropdown. */
export function helpView(bot, { categoryId, isAdmin, viewerId }) {
  const category = categoryById(categoryId, isAdmin);
  const ping = bot.raya.readyNodes.reduce(
    (best, node) => (node.ping >= 0 && (best === null || node.ping < best) ? node.ping : best),
    null,
  );
  return {
    name: bot.client.user?.displayName ?? 'Raya',
    avatar: bot.client.user?.displayAvatarURL({ extension: 'png', size: 128 }) ?? null,
    tagline: 'music that never stops',
    announcement: latestAnnouncement(bot.config.announcement),
    category,
    categories: dropdownCategories(isAdmin),
    sections: helpSections(categoryId, isAdmin),
    overview: helpOverview(isAdmin),
    stats: {
      servers: bot.client.guilds.cache.size,
      playing: bot.raya.stats.playingPlayers,
      ping,
      version: VERSION,
      uptime: bot.client.uptime ?? Math.round(process.uptime() * 1000),
    },
    links: { ...bot.config.links, invite: bot.invite() },
    viewerId,
  };
}

const help = {
  data: new SlashCommandBuilder().setName('help').setDescription('What Raya can do, and everything it can play'),
  async run({ interaction, bot }) {
    const view = helpView(bot, {
      categoryId: 'all', // every command at once; the dropdown narrows it down
      isAdmin: isManager(interaction),
      viewerId: interaction.user.id,
    });
    await interaction.reply(create(renderHelp(view)));
  },
};

/** Live numbers for /stats: the bot, its players and every Lavalink node. */
export function statsView(bot) {
  const stats = bot.raya.stats;
  return {
    name: bot.client.user?.displayName ?? 'Raya',
    avatar: bot.client.user?.displayAvatarURL({ extension: 'png', size: 128 }) ?? null,
    servers: bot.client.guilds.cache.size,
    players: stats.players,
    playing: stats.playingPlayers,
    queued: [...bot.raya.players.values()].reduce((total, player) => total + player.queue.size, 0),
    uptime: bot.client.uptime ?? Math.round(process.uptime() * 1000),
    memory: process.memoryUsage().rss,
    gateway: Math.max(0, Math.round(bot.client.ws?.ping ?? 0)),
    versions: { raya: VERSION, discord: discordVersion, node: process.versions.node },
    nodes: [...bot.raya.nodes.values()].map((node) => ({
      name: node.name,
      connected: node.connected,
      ping: node.ping,
      players: node.stats?.players ?? node.players.size,
      playing: node.stats?.playingPlayers ?? 0,
      cpu: node.stats?.cpu?.lavalinkLoad ?? null,
      memory: node.stats?.memory?.used ?? null,
      uptime: node.stats?.uptime ?? null,
      version: node.info?.version?.semver ?? null,
    })),
  };
}

const stats = {
  data: new SlashCommandBuilder().setName('stats').setDescription('Bot, player and music server numbers'),
  async run({ interaction, bot }) {
    await interaction.reply(create(renderStats(statsView(bot))));
  },
};

const ping = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Check the bot and Lavalink latency'),
  async run({ interaction, bot }) {
    const nodes = bot.raya.readyNodes;
    const lines = nodes.length
      ? nodes.map((node) => `Lavalink **${node.name}** · ${node.ping >= 0 ? `${node.ping}ms` : 'measuring…'}`)
      : ['No music server is connected right now.'];
    await interaction.reply(
      create(notice(`Discord gateway **${Math.max(0, Math.round(bot.client.ws?.ping ?? 0))}ms**`, { note: lines.join(' · ') })),
    );
  },
};

export default [lyrics, ping, stats, help];
