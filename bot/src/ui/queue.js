import { button, ButtonStyle, card, row, select } from './components.js';
import { emojis } from './emojis.js';
import { command } from './mentions.js';
import {
  artwork,
  clean,
  humanDuration,
  length,
  plural,
  requesterMention,
  requesterName,
  trackAuthor,
  trackLink,
  truncate,
} from './format.js';

export const PAGE_SIZE = 10;

export function pageCount(player) {
  return Math.max(1, Math.ceil(player.queue.size / PAGE_SIZE));
}

export function clampPage(player, page) {
  const value = Number.isInteger(page) ? page : 0;
  return Math.min(Math.max(0, value), pageCount(player) - 1);
}

const LOOP_NOTES = { off: null, queue: 'looping the queue', track: 'repeating the current song' };

function nowPlayingBlock(player) {
  const track = player.current;
  if (!track) return `Nothing is playing. Start with ${command('play')}.`;
  const who = requesterMention(track);
  return (
    `${player.paused ? emojis.paused : emojis.playing} **${trackLink(track, 70)}**\n` +
    `-# ${trackAuthor(track, 40)} · ${length(track)}${who ? ` · requested by ${who}` : ''}`
  );
}

function listBlock(player, page) {
  const size = player.queue.size;
  if (size === 0) {
    return player.autoplay
      ? `The queue is empty · autoplay will keep the music going.\n-# Add your own songs with ${command('play')}.`
      : `The queue is empty.\n-# Add songs with ${command('play')}, or turn on autoplay to keep the music going.`;
  }
  const start = page * PAGE_SIZE;
  const width = String(Math.min(size, start + PAGE_SIZE)).length;
  return player.queue
    .slice(start, start + PAGE_SIZE)
    .map((track, i) => {
      const position = String(start + i + 1).padStart(width, '0');
      const who = requesterName(track);
      return `\`${position}\` ${trackLink(track, 46)} — ${trackAuthor(track, 24)} \`${length(track)}\`${who ? ` · ${who}` : ''}`;
    })
    .join('\n');
}

function footerBlock(player, page, pages) {
  const size = player.queue.size;
  const parts = [`Page ${page + 1} of ${pages}`, plural(size, 'song')];
  if (size > 0) parts.push(`${humanDuration(player.queue.duration)} left`);
  if (LOOP_NOTES[player.loop]) parts.push(LOOP_NOTES[player.loop]);
  if (player.autoplay) parts.push('autoplay on');
  return `-# ${parts.join(' · ')}`;
}

/** One page of the queue: what's playing, what's next, and the controls to change it. */
export function renderQueue(player, requestedPage = 0) {
  const page = clampPage(player, requestedPage);
  const pages = pageCount(player);
  const size = player.queue.size;
  const start = page * PAGE_SIZE;

  const jumpOptions = player.queue.slice(start, start + PAGE_SIZE).map((track, i) => ({
    label: truncate(`${start + i + 1}. ${track.info.title || 'Unknown title'}`, 100),
    value: String(start + i + 1),
    description: truncate(`${track.info.author || 'Unknown artist'} · ${length(track)}`, 100),
    emoji: emojis.skip,
  }));

  return card(
    [nowPlayingBlock(player), listBlock(player, page), footerBlock(player, page, pages)],
    [
      select(`queue:jump:${page}`, { placeholder: 'Jump to a song in the queue', options: jumpOptions }),
      row(
        button(`queue:page:${page - 1}`, { emoji: emojis.back, disabled: page === 0 }),
        button(`queue:page:${page + 1}`, { emoji: emojis.forward, disabled: page >= pages - 1 }),
        button(`queue:page:${page}`, { emoji: emojis.refresh, label: 'Refresh' }),
        button(`queue:shuffle:${page}`, { emoji: emojis.shuffle, label: 'Shuffle', disabled: size < 2 }),
        button(`queue:clear:${page}`, { emoji: emojis.clear, label: 'Clear', style: ButtonStyle.Danger, disabled: size === 0 }),
      ),
    ],
    { thumbnail: { url: artwork(player.current), description: `Cover art for ${player.current?.info.title ?? 'the queue'}` } },
  );
}

/** Asks before clearing, since it can't be undone. */
export function renderClearConfirm(player, page) {
  return card(
    [`Clear all ${plural(player.queue.size, 'song')} from the queue?\n-# The song that's playing now keeps playing.`],
    [
      row(
        button('queue:clear-confirm', { emoji: emojis.clear, label: 'Clear queue', style: ButtonStyle.Danger }),
        button(`queue:page:${clampPage(player, page)}`, { label: 'Cancel' }),
      ),
    ],
  );
}

/** Shown after jumping to a song from the dropdown. */
export function jumpedNote(track, skipped) {
  return `Jumped to ${trackLink(track, 60)}${skipped > 0 ? `\n-# ${plural(skipped, 'song')} skipped · ${clean(track.info.author || '', 40)}` : ''}`;
}
