import { defaultAutoplay } from 'raya.js';

/**
 * Start a related song after the queue has already ended (autoplay only kicks in when a song
 * finishes, so turning it on afterwards needs a nudge). Returns the started track or null.
 */
export async function startAutoplay(player) {
  const last = player.queue.previous;
  if (player.current || !last) return null;
  const track = await defaultAutoplay(player, last);
  if (!track || player.destroyed || player.current) return null;
  await player.play(track);
  return track;
}
