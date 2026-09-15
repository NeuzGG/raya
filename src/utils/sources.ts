/**
 * Friendly search source aliases mapped to Lavalink search prefixes.
 * Sources other than YouTube/SoundCloud/Bandcamp need plugins (youtube-source, LavaSrc, ...).
 */
export const SearchSources = {
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
} as const;

export type SearchSourceAlias = keyof typeof SearchSources;

const URL_RE = /^https?:\/\//i;
/** Matches identifiers that already carry a prefix, e.g. `ytsearch:`, `sprec:`, `dzisrc:`. */
const PREFIX_RE = /^[a-z]{2,12}(?:search|rec|isrc):/i;

export function isUrl(query: string): boolean {
  return URL_RE.test(query);
}

export function resolveSourcePrefix(source: string): string {
  const alias = source.toLowerCase() as SearchSourceAlias;
  return SearchSources[alias] ?? source;
}

/**
 * Turn a user query into a Lavalink identifier:
 * URLs and already-prefixed identifiers pass through, everything else gets the source prefix.
 */
export function buildIdentifier(query: string, source: string): string {
  const trimmed = query.trim();
  if (URL_RE.test(trimmed) || PREFIX_RE.test(trimmed)) return trimmed;
  return `${resolveSourcePrefix(source)}:${trimmed}`;
}
