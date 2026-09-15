import type { LavalinkTrack } from '../types/lavalink';

type TrackLike = Pick<LavalinkTrack, 'encoded' | 'info'>;

/**
 * Whether two tracks are the same song.
 *
 * Never compare `encoded` alone: Lavalink re-encodes tracks for every event and player state,
 * and the encoding includes the playback position, so a track's `encoded` string in a
 * TrackEndEvent differs from the one that was sent to play it.
 */
export function isSameTrack(a: TrackLike | null | undefined, b: TrackLike | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.encoded === b.encoded) return true;
  return a.info.sourceName === b.info.sourceName && a.info.identifier === b.info.identifier;
}
