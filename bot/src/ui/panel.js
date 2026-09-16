import { button, ButtonStyle, card, row } from './components.js';
import { emojis } from './emojis.js';
import { command } from './mentions.js';
import { filterLabels } from '../music/filters.js';
import {
  artwork,
  clean,
  duration,
  humanDuration,
  plural,
  requesterMention,
  sourceName,
  timestamp,
  trackAuthor,
  trackLink,
} from './format.js';

const LOOP_LABELS = { off: 'Loop', queue: 'Loop: queue', track: 'Loop: song' };

/** Whether the player's Lavalink node has a lyrics plugin (LavaLyrics or similar). */
export function hasLyrics(player) {
  return player.node?.info?.plugins?.some((plugin) => /lyrics/i.test(plugin.name)) ?? false;
}

function stateLine(player, now, options) {
  const track = player.current;
  const emptySince = player.data.get('emptySince');
  const leaving = typeof emptySince === 'number' && options.emptyLeaveDelay > 0
    ? ` · leaving ${timestamp(emptySince + options.emptyLeaveDelay)}`
    : '';

  if (typeof emptySince === 'number' && player.paused) {
    return `${emojis.paused} Paused until someone joins${leaving}`;
  }
  if (track.info.isStream) return `${emojis.live} Live${player.paused ? ' · paused' : ''}`;
  if (player.paused) {
    return `${emojis.paused} Paused at \`${duration(player.position)}\` of \`${duration(track.info.length)}\``;
  }
  if (player.loop === 'track') return `${emojis.loopTrack} On repeat · \`${duration(track.info.length)}\``;
  const speed = player.filters.speedMultiplier || 1;
  const endsAt = now + Math.max(0, track.info.length - player.position) / speed;
  return `${emojis.playing} Ends ${timestamp(endsAt)} · \`${duration(track.info.length)}\``;
}

function upNext(player) {
  const next = player.queue.next;
  if (next) {
    return `Up next ${trackLink(next, 45)} · ${plural(player.queue.size, 'song')} in queue · ${humanDuration(player.queue.duration)}`;
  }
  if (player.loop === 'queue' && player.queue.history.length > 0) return 'Up next: the queue starts over';
  if (player.autoplay) return 'Up next: a related song picked by autoplay';
  return `Nothing up next · add songs with ${command('play')}`;
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

/**
 * The live player. Text blocks and dividers only (no header, no accent color), then the controls.
 * Nothing on it goes stale: the end time is a Discord timestamp that counts down by itself.
 */
export function renderPanel(player, options = {}) {
  const track = player.current;
  if (!track) return renderQueueEnd(player, player.queue.previous ?? null, options);
  const now = options.now ?? Date.now();

  const who = requesterMention(track);
  const details = [
    `${who ? `Requested by ${who} · ` : ''}${sourceName(track.info.sourceName)}`,
    upNext(player),
    settingsLine(player),
  ];

  return card(
    [
      `**${trackLink(track, 80)}**\n${trackAuthor(track, 60)}\n${stateLine(player, now, options)}`,
      details.map((line) => `-# ${line}`).join('\n'),
    ],
    playerRows(player),
    { thumbnail: { url: artwork(track), description: `Cover art for ${track.info.title}` } },
  );
}

/** The two rows of controls under the player, shared with the song request dashboard. */
export function playerRows(player) {
  return [
    row(
      button('player:previous', { emoji: emojis.previous, disabled: player.queue.history.length === 0 }),
      button('player:toggle', { emoji: player.paused ? emojis.resume : emojis.pause, style: ButtonStyle.Primary }),
      button('player:skip', { emoji: emojis.skip }),
      button('player:shuffle', { emoji: emojis.shuffle, disabled: player.queue.size < 2 }),
      button('player:stop', { emoji: emojis.stop, style: ButtonStyle.Danger }),
    ),
    row(
      button('player:loop', {
        emoji: player.loop === 'track' ? emojis.loopTrack : emojis.loop,
        label: LOOP_LABELS[player.loop],
        style: player.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Primary,
      }),
      button('player:autoplay', {
        emoji: emojis.autoplay,
        label: 'Autoplay',
        style: player.autoplay ? ButtonStyle.Primary : ButtonStyle.Secondary,
      }),
      button('player:sound', { emoji: emojis.sound, label: 'Sound' }),
      button('player:queue', { emoji: emojis.queue, label: player.queue.size > 0 ? `Queue · ${player.queue.size}` : 'Queue' }),
      hasLyrics(player) && button('player:lyrics', { emoji: emojis.lyrics, label: 'Lyrics' }),
    ),
  ];
}

/** Shown when the queue runs out while the bot stays in the channel. */
export function renderQueueEnd(player, lastTrack, options = {}) {
  const endedAt = player.data.get('queueEndedAt');
  const leaving = typeof endedAt === 'number' && options.queueEndLeaveDelay > 0
    ? ` I'll leave ${timestamp(endedAt + options.queueEndLeaveDelay)} if nothing is added.`
    : '';

  return card(
    [
      lastTrack
        ? `The queue has ended\n-# Last played ${trackLink(lastTrack, 60)} · ${trackAuthor(lastTrack, 40)}`
        : 'The queue is empty',
      `-# Add songs with ${command('play')} or turn on autoplay to keep the music going.${leaving}`,
    ],
    [
      row(
        button('player:replay', { emoji: emojis.replay, label: 'Play again', disabled: !lastTrack }),
        button('player:autoplay', {
          emoji: emojis.autoplay,
          label: player.autoplay ? 'Autoplay on' : 'Autoplay',
          style: player.autoplay ? ButtonStyle.Primary : ButtonStyle.Secondary,
          disabled: !lastTrack,
        }),
        button('player:leave', { emoji: emojis.leave, label: 'Leave', style: ButtonStyle.Danger }),
      ),
    ],
    lastTrack ? { thumbnail: { url: artwork(lastTrack), description: `Cover art for ${lastTrack.info.title}` } } : {},
  );
}

const GOODBYES = {
  manual: 'Stopped the music and left the voice channel',
  stopped: 'Stopped the music and left the voice channel',
  queueEnd: 'Left the voice channel after the queue ended',
  channelEmpty: 'Left because everyone left the voice channel',
  voiceDisconnected: 'Disconnected from the voice channel',
  channelDeleted: 'Left because the voice channel was deleted',
  guildDeleted: 'Left the server',
  voiceTimeout: "Couldn't connect to the voice channel",
};

/** The final state of a panel once the player is gone. No buttons. */
export function renderGoodbye(player, reason) {
  const songs = player.data.get('songs');
  const since = player.data.get('since');
  const stats = [];
  if (typeof songs === 'number' && songs > 0) stats.push(`Played ${plural(songs, 'song')}`);
  if (typeof since === 'number') stats.push(`${humanDuration(Date.now() - since)} in voice`);
  const stoppedBy = player.data.get('stoppedBy');
  if (typeof stoppedBy === 'string' && /^\d{15,25}$/.test(stoppedBy)) stats.push(`Stopped by <@${stoppedBy}>`);

  return card([
    `${GOODBYES[reason] ?? 'Left the voice channel'}${stats.length ? `\n-# ${stats.join(' · ')}` : ''}`,
  ]);
}

/** A short card for a song that couldn't be played. */
export function renderTrackProblem(track, message) {
  return card([
    `Couldn't play ${trackLink(track, 60)}\n-# ${clean(message || 'The source refused to play it', 150)} · skipping to the next song`,
  ]);
}
