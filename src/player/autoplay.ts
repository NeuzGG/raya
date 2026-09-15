import type { Player } from './Player';
import type { AutoplayResolver, SearchResult, Track } from '../types/raya';
import { resolveSourcePrefix } from '../utils/sources';

/** Search prefix per Lavalink sourceName, so related tracks come from the same service. */
const SOURCE_SEARCH: Record<string, string> = {
  youtube: 'ytsearch',
  youtubemusic: 'ytmsearch',
  soundcloud: 'scsearch',
  bandcamp: 'bcsearch',
  spotify: 'spsearch',
  applemusic: 'amsearch',
  deezer: 'dzsearch',
  yandexmusic: 'ymsearch',
  tidal: 'tdsearch',
  jiosaavn: 'jssearch',
  vkmusic: 'vksearch',
  qobuz: 'qbsearch',
};

/** Source manager a search prefix needs on the node. */
const PREFIX_SOURCE: Record<string, string> = {
  ytsearch: 'youtube',
  ytmsearch: 'youtube',
  scsearch: 'soundcloud',
  bcsearch: 'bandcamp',
  spsearch: 'spotify',
  amsearch: 'applemusic',
  dzsearch: 'deezer',
  ymsearch: 'yandexmusic',
  tdsearch: 'tidal',
  jssearch: 'jiosaavn',
  vksearch: 'vkmusic',
  qbsearch: 'qobuz',
};

/** LavaSrc recommendation queries per sourceName. */
const RECOMMENDATIONS: Record<string, (id: string) => string[]> = {
  // `mix:` works with anonymous tokens; `seed_tracks` needs Spotify Extended quota mode.
  spotify: (id) => [`sprec:mix:track:${id}`, `sprec:seed_tracks=${id}`],
  deezer: (id) => [`dzrec:${id}`],
  yandexmusic: (id) => [`ymrec:${id}`],
  vkmusic: (id) => [`vkrec:${id}`],
  tidal: (id) => [`tdrec:${id}`],
  qobuz: (id) => [`qbrec:${id}`],
  jiosaavn: (id) => [`jsrec:${id}`],
};

const normalizeTitle = (title: string) =>
  title
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/\b(official|music|video|audio|lyrics?|visualizer|hd|4k|mv)\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Candidate identifiers for tracks related to `track`, best first:
 * 1. the source's own recommendations (YouTube mix, LavaSrc `sprec:` / `dzrec:` / ...),
 * 2. a Spotify radio from the ISRC for tracks from other services,
 * 3. more from the same artist on the same source, the default search source, then YouTube.
 * Queries for sources the node does not have are skipped once its /v4/info is known.
 */
export function relatedQueries(player: Player, track: Track): string[] {
  const { sourceName, identifier, author, title, isrc } = track.info;
  const node = player.node;
  const available = (source: string | undefined) => !source || node.info === null || node.hasSource(source);
  const queries: string[] = [];

  if (sourceName === 'youtube' || sourceName === 'youtubemusic') {
    queries.push(`https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`);
  } else if (RECOMMENDATIONS[sourceName] && available(sourceName)) {
    queries.push(...RECOMMENDATIONS[sourceName]!(identifier));
  }

  if (isrc && sourceName !== 'spotify' && node.hasSource('spotify')) {
    queries.push(`sprec:mix:isrc:${isrc}`);
  }

  const term = author || title;
  if (term) {
    const prefixes = [SOURCE_SEARCH[sourceName], resolveSourcePrefix(player.raya.defaultSearchSource), 'ytmsearch', 'ytsearch'];
    for (const prefix of prefixes) {
      if (prefix && available(PREFIX_SOURCE[prefix])) queries.push(`${prefix}:${term}`);
    }
  }
  return [...new Set(queries)];
}

/**
 * Default autoplay: walks `relatedQueries` and returns the first track that was not played
 * recently (by id or by normalized title). Every attempt is visible with `debug: true`.
 */
export const defaultAutoplay: AutoplayResolver = async (player, lastTrack) => {
  const recent = [lastTrack, ...player.queue.history.slice(-50)];
  const seenIds = new Set(recent.map((t) => `${t.info.sourceName}:${t.info.identifier}`));
  const seenTitles = new Set(recent.map((t) => normalizeTitle(t.info.title)).filter(Boolean));
  const tag = `[Player ${player.guildId}] autoplay`;

  for (const query of relatedQueries(player, lastTrack)) {
    let result: SearchResult;
    try {
      result = await player.search(query, { requester: lastTrack.requester });
    } catch (error) {
      player.raya.debug(() => `${tag} "${query}" failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const pick = result.tracks.find((t) => {
      if (t.info.isStream) return false;
      if (seenIds.has(`${t.info.sourceName}:${t.info.identifier}`)) return false;
      const normalized = normalizeTitle(t.info.title);
      return !normalized || !seenTitles.has(normalized);
    });
    player.raya.debug(
      () =>
        `${tag} "${query}" -> ${result.type}${result.exception ? ` (${result.exception.message})` : ` (${result.tracks.length} tracks)`}` +
        (pick ? `, picked "${pick.info.title}"` : result.tracks.length ? ', all already played' : ''),
    );
    if (pick) return pick;
  }
  return null;
};
