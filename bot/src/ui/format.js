const SOURCE_NAMES = {
  youtube: 'YouTube',
  youtubemusic: 'YouTube Music',
  spotify: 'Spotify',
  soundcloud: 'SoundCloud',
  applemusic: 'Apple Music',
  deezer: 'Deezer',
  bandcamp: 'Bandcamp',
  twitch: 'Twitch',
  vimeo: 'Vimeo',
  tidal: 'Tidal',
  jiosaavn: 'JioSaavn',
  yandexmusic: 'Yandex Music',
  vkmusic: 'VK Music',
  qobuz: 'Qobuz',
  http: 'Web',
  local: 'Local file',
};

const pad = (value) => String(value).padStart(2, '0');

/** 3:45 or 1:02:03 */
export function duration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** 2h 13m, 45m or 30s */
export function humanDuration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (!hours) return `${minutes}m`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** The track length, or LIVE for streams. */
export function length(track) {
  return track.info.isStream ? 'LIVE' : duration(track.info.length);
}

/**
 * Parse a time like `1:30`, `1:02:03`, `90`, `2m`, `1h2m3s` into ms. Returns null when invalid.
 */
export function parseTime(input) {
  const value = String(input ?? '').trim().toLowerCase();
  if (/^\d+(:\d{1,2}){1,2}$/.test(value)) {
    return value.split(':').reduce((total, part) => total * 60 + Number(part), 0) * 1000;
  }
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const match = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/.exec(value);
  if (match && (match[1] || match[2] || match[3])) {
    return ((Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 1000;
  }
  return null;
}

/** Cut text to `max` characters (by code point) with an ellipsis. */
export function truncate(value, max) {
  const chars = [...String(value ?? '')];
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…` : chars.join('');
}

/** Escape inline markdown, plus headings, quotes and lists at the start of a line. */
function escapeLine(line) {
  return line
    .replace(/[\\*_~|`[\]<>]/g, '\\$&')
    .replace(/^(\s*)([#>+-])/, '$1\\$2')
    .replace(/^(\s*\d+)\./, '$1\\.');
}

/** Single-line, length-limited text that can't break or inject markdown. */
export function clean(value, max = 100) {
  return escapeLine(truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), max));
}

/** Escape markdown in multi-line text (lyrics), keeping line breaks. */
export function escapeBlock(value) {
  return String(value ?? '').split('\n').map(escapeLine).join('\n');
}

/** A URL that is safe inside a markdown link, or null. */
export function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^https?:\/\/[^\s<>]+$/i.test(value)) return null;
  return value.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/** `[Title](url)` or just the title. */
export function trackLink(track, max = 60) {
  const title = clean(track.info.title || 'Unknown title', max);
  const link = safeUrl(track.info.uri);
  return link ? `[${title}](${link})` : title;
}

export function trackAuthor(track, max = 40) {
  return clean(track.info.author || 'Unknown artist', max);
}

export function sourceName(name) {
  return SOURCE_NAMES[name] ?? (name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Unknown source');
}

/** `<@id>` for the user who requested the track, or null. */
export function requesterMention(track) {
  const id = track.requester?.id;
  return typeof id === 'string' && /^\d{15,25}$/.test(id) ? `<@${id}>` : null;
}

/** Discord timestamp that updates live in the client, e.g. "in 3 minutes". */
export function timestamp(ms, style = 'R') {
  return `<t:${Math.round(ms / 1000)}:${style}>`;
}

export function plural(count, word, suffix = 's') {
  return `${count} ${count === 1 ? word : word + suffix}`;
}
