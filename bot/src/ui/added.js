import { notice } from './components.js';
import { artwork, clean, humanDuration, length, plural, safeUrl, trackAuthor, trackLink } from './format.js';

/** Cover art for a playlist: the playlist's own art, or the first song's. */
function playlistArtwork(result, added) {
  return (
    safeUrl(result.playlist?.pluginInfo?.artworkUrl) ??
    safeUrl(result.playlist?.pluginInfo?.thumbnail) ??
    artwork(added[0]) ??
    null
  );
}

export function addedCard(player, result, added, { playNext, total }) {
  const left = total - added.length;
  const full = left > 0 ? ` · the queue is full, ${plural(left, 'song')} left out` : '';
  if (result.type === 'playlist') {
    const time = humanDuration(added.reduce((sum, track) => sum + (track.info.isStream ? 0 : track.info.length), 0));
    const name = clean(result.playlist?.name ?? 'playlist', 80);
    return notice(`Added **${plural(added.length, 'song')}** from **${name}**`, {
      note: `${time} · ${playNext ? 'playing next' : `starting at #${player.queue.indexOf(added[0]) + 1} in the queue`}${full}`,
      thumbnail: { url: playlistArtwork(result, added), description: `Cover art for ${result.playlist?.name ?? 'the playlist'}` },
    });
  }
  const [track] = added;
  const position = player.queue.indexOf(track) + 1;
  return notice(`Added ${trackLink(track, 70)} · ${trackAuthor(track, 40)}`, {
    note: `${length(track)} · ${position === 1 ? 'plays next' : `#${position} in the queue`}${full}`,
    thumbnail: { url: artwork(track), description: `Cover art for ${track.info.title}` },
  });
}
