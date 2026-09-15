import { button, ButtonStyle, card, row } from './components.js';
import { emojis } from './emojis.js';
import { command } from './mentions.js';
import { humanDuration, length, plural, requesterMention, trackAuthor, trackLink } from './format.js';

export const PAGE_SIZE = 10;

export function pageCount(player) {
  return Math.max(1, Math.ceil(player.queue.size / PAGE_SIZE));
}

function clampPage(player, page) {
  const value = Number.isInteger(page) ? page : 0;
  return Math.min(Math.max(0, value), pageCount(player) - 1);
}

const LOOP_NOTES = { off: null, queue: 'looping the queue', track: 'repeating the current song' };

/** One page of the queue with paging, shuffle and clear buttons. */
export function renderQueue(player, requestedPage = 0) {
  const page = clampPage(player, requestedPage);
  const pages = pageCount(player);
  const size = player.queue.size;
  const blocks = [];

  const current = player.current;
  if (current) {
    const who = requesterMention(current);
    blocks.push(
      `${player.paused ? emojis.paused : emojis.playing} **${trackLink(current, 70)}**\n` +
        `-# ${trackAuthor(current, 40)} · ${length(current)}${who ? ` · requested by ${who}` : ''}`,
    );
  }

  if (size === 0) {
    blocks.push(`The queue is empty. Add songs with ${command('play')}.`);
  } else {
    const start = page * PAGE_SIZE;
    const width = String(Math.min(size, start + PAGE_SIZE)).length;
    blocks.push(
      player.queue
        .slice(start, start + PAGE_SIZE)
        .map((track, i) => `\`${String(start + i + 1).padStart(width, '0')}\` ${trackLink(track, 50)} · ${trackAuthor(track, 30)} · \`${length(track)}\``)
        .join('\n'),
    );
  }

  const footer = [`Page ${page + 1} of ${pages}`, plural(size, 'song'), `${humanDuration(player.queue.duration)} left`];
  if (LOOP_NOTES[player.loop]) footer.push(LOOP_NOTES[player.loop]);
  if (player.autoplay) footer.push('autoplay on');
  blocks.push(`-# ${footer.join(' · ')}`);

  return card(blocks, [
    row(
      button(`queue:page:${page - 1}`, { emoji: emojis.back, disabled: page === 0 }),
      button(`queue:page:${page + 1}`, { emoji: emojis.forward, disabled: page >= pages - 1 }),
      button(`queue:page:${page}`, { emoji: emojis.refresh, label: 'Refresh' }),
      button(`queue:shuffle:${page}`, { emoji: emojis.shuffle, label: 'Shuffle', disabled: size < 2 }),
      button(`queue:clear:${page}`, { emoji: emojis.clear, label: 'Clear', style: ButtonStyle.Danger, disabled: size === 0 }),
    ),
  ]);
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
