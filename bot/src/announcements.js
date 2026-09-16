/**
 * Shown at the top of /help, newest first. Add an entry when something ships.
 * `ANNOUNCEMENT` in bot/.env overrides this without touching the code.
 */
export const ANNOUNCEMENTS = [
  {
    date: '2026-09-16',
    title: 'The official Raya bot is here',
    text: 'One live player per server with buttons for everything, cover art on every song, a sound board with filters, a queue you can jump around in, and /setup for a song request channel where you just type a song name.',
  },
];

/** The newest announcement, or the one set in the environment. */
export function latestAnnouncement(override) {
  if (typeof override === 'string' && override.trim()) return { date: null, title: 'Announcement', text: override.trim() };
  return ANNOUNCEMENTS[0] ?? null;
}
