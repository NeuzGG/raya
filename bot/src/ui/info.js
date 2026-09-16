import { card, linkButton, row, select } from './components.js';
import { emojis } from './emojis.js';
import { command } from './mentions.js';
import { clean, escapeBlock, humanDuration, inline, plural, trackAuthor, trackLink, truncate } from './format.js';

const LYRICS_LIMIT = 3000;

/** Lyrics of a track, trimmed to fit a message. */
export function renderLyrics(track, lyrics) {
  const raw = (lyrics.text ?? lyrics.lines.map((line) => line.line).join('\n')).replace(/\r/g, '').trim();
  let body = escapeBlock(truncate(raw, LYRICS_LIMIT));
  if (body.length > LYRICS_LIMIT + 400) body = `${body.slice(0, LYRICS_LIMIT + 400).replace(/\\$/, '')}…`;
  const provider = lyrics.provider || lyrics.sourceName;

  return card(
    [
      `**${trackLink(track, 80)}**\n${trackAuthor(track, 60)}`,
      body || 'These lyrics are empty.',
      `-# Lyrics${provider ? ` from ${inline(provider, 40)}` : ''}${raw.length > LYRICS_LIMIT ? ' · shortened to fit' : ''}`,
    ],
    [],
    { thumbnail: { url: track.info.artworkUrl, description: `Cover art for ${track.info.title}` } },
  );
}

function announcementBlock(announcement) {
  if (!announcement) return null;
  const when = announcement.date
    ? new Date(`${announcement.date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    : null;
  return `**${clean(announcement.title, 80)}**${when ? ` · ${when}` : ''}\n${clean(announcement.text, 400)}`;
}

function commandsBlock(category, commands) {
  if (commands.length === 0) return `${category.emoji} **${category.label}**\nIt has no commands yet.`;
  const lines = commands.map((entry) => {
    const args = entry.usage ? ` \`${entry.usage}\`` : '';
    return `${command(entry.name)}${args} — ${entry.summary}`;
  });
  return `${category.emoji} **${category.label}**\nIt has ${plural(commands.length, 'command')}\n${lines.join('\n')}`;
}

function statsBlock(stats) {
  const parts = [
    plural(stats.servers, 'server'),
    `playing in ${stats.playing}`,
    stats.ping !== null && stats.ping >= 0 ? `Lavalink ${stats.ping}ms` : 'Lavalink offline',
    `up ${humanDuration(stats.uptime)}`,
    `raya.js ${stats.version}`,
  ];
  return `-# ${parts.join(' · ')}`;
}

/**
 * The public help card: what the bot is, what's new, the commands of one category,
 * a dropdown to switch category, and the links.
 *
 * @param {{
 *   name: string,
 *   avatar?: string | null,
 *   tagline?: string,
 *   announcement?: { date: string | null, title: string, text: string } | null,
 *   category: { id: string, label: string, emoji: string, description?: string },
 *   categories: Array<{ id: string, label: string, emoji: string, description?: string }>,
 *   commands: Array<{ name: string, usage?: string, summary: string }>,
 *   stats: { servers: number, playing: number, ping: number | null, version: string, uptime: number },
 *   links: { invite?: string | null, website?: string | null, github?: string | null, support?: string | null },
 *   viewerId: string,
 * }} view
 */
export function renderHelp(view) {
  const intro =
    `**${clean(view.name || 'Raya', 40)}** · ${clean(view.tagline || 'music that never stops', 80)}\n` +
    `Play music from YouTube, Spotify, SoundCloud and more. Type **/** in the chat to see every command, ` +
    `use the buttons on the player, or pick a category below.`;

  return card(
    [intro, announcementBlock(view.announcement), commandsBlock(view.category, view.commands), statsBlock(view.stats)],
    [
      select(`help:${view.viewerId}`, {
        placeholder: 'Browse the commands by category',
        options: view.categories.map((category) => ({
          label: category.label,
          value: category.id,
          description: category.description,
          emoji: category.emoji,
        })),
      }),
      row(
        view.links.invite && linkButton(view.links.invite, 'Add to server', emojis.invite),
        view.links.website && linkButton(view.links.website, 'Website', emojis.website),
        view.links.github && linkButton(view.links.github, 'GitHub', emojis.code),
        view.links.support && linkButton(view.links.support, 'Support', emojis.support),
      ),
    ],
    { thumbnail: { url: view.avatar, description: `${view.name || 'Raya'} avatar` } },
  );
}

const megabytes = (bytes) => (typeof bytes === 'number' && bytes > 0 ? `${Math.round(bytes / 1024 / 1024)} MB` : null);

function nodeLine(node) {
  const parts = [node.connected ? (node.ping >= 0 ? `${node.ping}ms` : 'connected') : 'offline'];
  parts.push(`${plural(node.players, 'player')}, ${node.playing} playing`);
  if (typeof node.cpu === 'number') parts.push(`CPU ${Math.round(node.cpu * 100)}%`);
  const used = megabytes(node.memory);
  if (used) parts.push(used);
  if (node.uptime) parts.push(`up ${humanDuration(node.uptime)}`);
  if (node.version) parts.push(`Lavalink ${inline(node.version, 24)}`);
  return `-# ${node.connected ? emojis.playing : emojis.paused} **${inline(node.name, 32)}** · ${parts.join(' · ')}`;
}

/** Live numbers: the bot, its players and every music server. */
export function renderStats(view) {
  const lines = [
    `Playing in ${plural(view.playing, 'server')} of ${view.servers}`,
    `${plural(view.players, 'player')} · ${plural(view.queued, 'song')} queued`,
    `Up ${humanDuration(view.uptime)} · ${megabytes(view.memory) ?? 'unknown memory'} · gateway ${view.gateway}ms`,
  ];
  const nodes = view.nodes.length ? view.nodes.map(nodeLine).join('\n') : '-# No music server is connected.';

  return card(
    [
      `**${clean(view.name || 'Raya', 40)}**\n${lines.map((line) => `-# ${line}`).join('\n')}`,
      `**Music servers**\n${nodes}`,
      `-# raya.js ${inline(view.versions.raya, 20)} · discord.js ${inline(view.versions.discord, 20)} · Node ${inline(view.versions.node, 20)}`,
    ],
    [],
    { thumbnail: { url: view.avatar, description: `${view.name || 'Raya'} avatar` } },
  );
}
