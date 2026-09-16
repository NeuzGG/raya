import { button, card, linkButton, row } from './components.js';
import { emojis } from './emojis.js';
import { command } from './mentions.js';
import { playerRows } from './panel.js';
import { filterLabels } from '../music/filters.js';
import {
  artwork,
  duration,
  humanDuration,
  length,
  plural,
  requesterMention,
  requesterName,
  sourceName,
  timestamp,
  trackAuthor,
  trackLink,
} from './format.js';

const UP_NEXT = 5;

function linkRow(links = {}) {
  return row(
    button('dashboard:help', { emoji: emojis.commands, label: 'Commands' }),
    links.invite && linkButton(links.invite, 'Add to server', emojis.invite),
    links.website && linkButton(links.website, 'Website', emojis.website),
    links.support && linkButton(links.support, 'Support', emojis.support),
  );
}

function howToPlay(setup, requests) {
  const where = setup?.voiceChannelId ? `Join <#${setup.voiceChannelId}>` : 'Join a voice channel';
  return requests
    ? `${where} and **send a song name or a link** in this channel.`
    : `${where} and start the music with ${command('play')}.`;
}

/** Waiting for a song: what to do, and where the music comes from. */
function idleCard({ name, avatar, setup, djRoleId, links, requests }) {
  const notes = ['YouTube, Spotify, SoundCloud, Apple Music, Deezer… a title, a link or a playlist all work.'];
  notes.push(
    requests
      ? `Prefer commands? ${command('play')} does the same, and this message becomes the player.`
      : 'This message becomes the player while the music runs.',
  );
  if (djRoleId) notes.push(`Anyone can add songs; only <@&${djRoleId}> can skip, stop or change the sound.`);

  return card(
    [`**${name}** · nothing is playing\n${howToPlay(setup, requests)}`, notes.map((note) => `-# ${note}`).join('\n')],
    [linkRow(links)],
    { thumbnail: { url: avatar, description: `${name} avatar` } },
  );
}

function stateLine(player, now) {
  const track = player.current;
  if (player.data.get('emptySince') && player.paused) return `${emojis.paused} Paused until someone joins`;
  if (track.info.isStream) return `${emojis.live} Live${player.paused ? ' · paused' : ''}`;
  if (player.paused) return `${emojis.paused} Paused at \`${duration(player.position)}\` of \`${duration(track.info.length)}\``;
  if (player.loop === 'track') return `${emojis.loopTrack} On repeat · \`${duration(track.info.length)}\``;
  const speed = player.filters.speedMultiplier || 1;
  return `${emojis.playing} Ends ${timestamp(now + Math.max(0, track.info.length - player.position) / speed)} · \`${duration(track.info.length)}\``;
}

/** Time left on the current song, in ms, honouring the playback speed. */
function remaining(player) {
  const track = player.current;
  if (!track || track.info.isStream) return 0;
  return Math.max(0, track.info.length - player.position) / (player.filters.speedMultiplier || 1);
}

/** When the whole queue would finish, unless it loops or autoplay keeps it going. */
function endsAt(player, now) {
  if (player.loop !== 'off' || player.autoplay || player.current?.info.isStream) return null;
  return now + remaining(player) + player.queue.duration;
}

function upNextBlock(player, setup, requests, now) {
  const size = player.queue.size;
  if (size === 0) {
    if (player.autoplay) return '**Up next**\n-# Autoplay will pick something related. Add a song to take over.';
    return `**Up next**\n-# Nothing yet. ${howToPlay(setup, requests)}`;
  }
  const lines = player.queue.slice(0, UP_NEXT).map((track, index) => {
    const who = requesterName(track);
    return `\`${index + 1}\` ${trackLink(track, 46)} — ${trackAuthor(track, 24)} \`${length(track)}\`${who ? ` · ${who}` : ''}`;
  });
  const rest = size - Math.min(size, UP_NEXT);
  const finish = endsAt(player, now);
  const summary = [
    plural(size, 'song'),
    `${humanDuration(player.queue.duration + remaining(player))} of music left`,
    finish ? `ends around ${timestamp(finish, 't')}` : null,
    rest > 0 ? `${rest} more not shown` : null,
  ].filter(Boolean);
  return `**Up next**\n${lines.join('\n')}\n-# ${summary.join(' · ')}`;
}

function settingsLine(player) {
  const parts = [`Volume ${player.volume}%`];
  if (player.loop === 'queue') parts.push('Looping the queue');
  if (player.loop === 'track') parts.push('Repeating this song');
  if (player.autoplay) parts.push('Autoplay on');
  const filters = filterLabels(player);
  if (filters.length > 0) parts.push(filters.join(', '));
  return parts.join(' · ');
}

/** How the session has been going: who is listening, and how much has been played. */
function sessionLine(player, listeners) {
  const parts = [];
  if (typeof listeners === 'number') parts.push(listeners === 1 ? '1 person listening' : `${listeners} people listening`);
  const songs = player.data.get('songs');
  if (typeof songs === 'number' && songs > 0) parts.push(`${plural(songs, 'song')} played`);
  const since = player.data.get('since');
  if (typeof since === 'number') parts.push(`${humanDuration(Date.now() - since)} in voice`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Playing: big cover art, what's next, and the full controls. */
function playingCard({ player, setup, links, now, requests, listeners }) {
  const track = player.current;
  const who = requesterMention(track);
  const footer = [
    `${who ? `Requested by ${who} · ` : ''}${sourceName(track.info.sourceName)} · \`${length(track)}\``,
    settingsLine(player),
    sessionLine(player, listeners),
  ].filter(Boolean);

  return card(
    [
      `**${trackLink(track, 80)}**\n${trackAuthor(track, 60)}\n${stateLine(player, now)}`,
      upNextBlock(player, setup, requests, now),
      footer.map((line) => `-# ${line}`).join('\n'),
    ],
    [...playerRows(player), linkRow(links)],
    { image: { url: artwork(track), description: `Cover art for ${track.info.title}` } },
  );
}

/**
 * The song request dashboard: one message that lives in the `/setup` channel. It shows how to
 * play, turns into the live player with cover art and the queue, and goes back to idle when the
 * music ends. It is edited in place, never reposted.
 */
export function renderDashboard({
  player = null,
  setup = null,
  name = 'Raya',
  avatar = null,
  djRoleId = null,
  links = {},
  requests = true,
  listeners = null,
  now = Date.now(),
} = {}) {
  if (player && !player.destroyed && player.current) return playingCard({ player, setup, links, now, requests, listeners });
  return idleCard({ name, avatar, setup, djRoleId, links, requests });
}

/** Kept for the tests and for anything that only wants the resting state. */
export function renderDashboardIdle(options = {}) {
  return renderDashboard({ ...options, player: null });
}

