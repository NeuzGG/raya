import { card, linkButton, row } from './components.js';
import { emojis } from './emojis.js';
import { command } from './mentions.js';
import { clean, escapeBlock, trackAuthor, trackLink, truncate } from './format.js';

const LYRICS_LIMIT = 3000;

/** Lyrics of a track, trimmed to fit a message. */
export function renderLyrics(track, lyrics) {
  const raw = (lyrics.text ?? lyrics.lines.map((line) => line.line).join('\n')).replace(/\r/g, '').trim();
  let body = escapeBlock(truncate(raw, LYRICS_LIMIT));
  if (body.length > LYRICS_LIMIT + 400) body = `${body.slice(0, LYRICS_LIMIT + 400).replace(/\\$/, '')}…`;
  const provider = lyrics.provider || lyrics.sourceName;

  return card([
    `**${trackLink(track, 80)}**\n${trackAuthor(track, 60)}`,
    body || 'These lyrics are empty.',
    `-# Lyrics${provider ? ` from ${clean(provider, 40)}` : ''}${raw.length > LYRICS_LIMIT ? ' · shortened to fit' : ''}`,
  ]);
}

export const HELP = [
  ['play', 'Play a song, playlist or link, or add it to the queue'],
  ['nowplaying', 'Bring the player to the bottom of the chat'],
  ['pause', 'Pause or resume'],
  ['skip', 'Skip the song, or jump to a song in the queue'],
  ['previous', 'Play the previous song again'],
  ['seek', 'Jump to a time, like 1:30, +10 or -10'],
  ['queue', 'See and manage the queue'],
  ['remove', 'Remove a song from the queue'],
  ['move', 'Move a song in the queue'],
  ['shuffle', 'Shuffle the queue'],
  ['loop', 'Loop the song or the whole queue'],
  ['autoplay', 'Keep playing related songs when the queue ends'],
  ['volume', 'Change the volume'],
  ['filters', 'Bass boost, nightcore, 8D and more'],
  ['lyrics', 'Lyrics of the current song'],
  ['stop', 'Stop the music and leave'],
];

/**
 * About the bot, the commands and links.
 * @param {{ servers: number, playing: number, ping: number | null, version: string, links: { website?: string | null, github?: string | null, support?: string | null, invite?: string | null } }} stats
 */
export function renderHelp(stats) {
  const status = [
    `${stats.servers} ${stats.servers === 1 ? 'server' : 'servers'}`,
    `playing in ${stats.playing}`,
    stats.ping !== null && stats.ping >= 0 ? `Lavalink ${stats.ping}ms` : 'Lavalink offline',
    `raya.js ${stats.version}`,
  ];

  return card(
    [
      `**Raya** plays music from YouTube, Spotify, SoundCloud and more in your voice channel.\nControl it with the buttons on the player, or with these commands:`,
      HELP.map(([name, description]) => `${command(name)} ${description}`).join('\n'),
      `-# ${status.join(' · ')}`,
    ],
    [
      row(
        stats.links.invite && linkButton(stats.links.invite, 'Add to server', emojis.invite),
        stats.links.website && linkButton(stats.links.website, 'Website', emojis.website),
        stats.links.github && linkButton(stats.links.github, 'GitHub', emojis.code),
        stats.links.support && linkButton(stats.links.support, 'Support', emojis.support),
      ),
    ],
  );
}
