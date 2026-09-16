/**
 * What /help shows: the categories and one row per command. Add a row when you add a command,
 * and the tests will tell you if you forget.
 */
export const CATEGORIES = [
  { id: 'music', label: 'Music', emoji: '🎵', description: 'Play, pause, skip and jump around' },
  { id: 'queue', label: 'Queue', emoji: '📜', description: 'See and change what plays next' },
  { id: 'sound', label: 'Sound', emoji: '🎛️', description: 'Volume, bass boost, nightcore and more' },
  { id: 'info', label: 'Info', emoji: '💡', description: 'About the bot, lyrics and links' },
  { id: 'admin', label: 'Admin', emoji: '🛡️', description: 'Server manager tools', adminOnly: true },
];

export const HELP = {
  play: { category: 'music', usage: 'query [next]', summary: 'Play a song, playlist or link' },
  nowplaying: { category: 'music', summary: 'Bring the player to the bottom of the chat' },
  pause: { category: 'music', summary: 'Pause the music' },
  resume: { category: 'music', summary: 'Resume the music' },
  skip: { category: 'music', usage: '[to]', summary: 'Skip the song, or jump to one in the queue' },
  previous: { category: 'music', summary: 'Play the previous song again' },
  seek: { category: 'music', usage: 'time', summary: 'Jump to a time, like 1:30, +10 or -10' },
  stop: { category: 'music', summary: 'Stop the music and leave' },

  queue: { category: 'queue', usage: '[page]', summary: 'See and manage the queue' },
  remove: { category: 'queue', usage: 'position', summary: 'Remove a song from the queue' },
  move: { category: 'queue', usage: 'from to', summary: 'Move a song to another place' },
  shuffle: { category: 'queue', summary: 'Shuffle the queue' },
  loop: { category: 'queue', usage: '[mode]', summary: 'Loop the song or the whole queue' },
  autoplay: { category: 'queue', usage: '[enabled]', summary: 'Keep playing related songs when the queue ends' },

  volume: { category: 'sound', usage: '[level]', summary: 'Change the volume, or open the sound board' },
  filters: { category: 'sound', usage: '[preset]', summary: 'Bass boost, nightcore, 8D and more' },

  lyrics: { category: 'info', summary: 'Lyrics of the current song' },
  ping: { category: 'info', summary: 'Check the bot and Lavalink latency' },
  stats: { category: 'info', summary: 'Bot, player and music server numbers' },
  help: { category: 'info', summary: 'This menu' },

  setup: { category: 'admin', usage: 'create | status | disable | delete', summary: 'Create a song request channel with a live dashboard' },
  dj: { category: 'admin', usage: 'set | clear | show', summary: 'Choose who can skip, stop and change the sound' },
  reset: { category: 'admin', summary: 'Force the player to stop and leave' },
  summon: { category: 'admin', summary: 'Move the bot to your voice channel' },
};

/** Categories a member can see. The admin category is only for people who can manage the server. */
export function visibleCategories(isAdmin) {
  return CATEGORIES.filter((category) => !category.adminOnly || isAdmin);
}

/** The default view of /help: how many commands there are, and where they live. */
export const EVERYTHING = { id: 'all', label: 'Overview', emoji: '📖', description: 'How many commands there are, and where' };

/** What the /help dropdown offers: everything first, then one entry per category. */
export function dropdownCategories(isAdmin) {
  return [EVERYTHING, ...visibleCategories(isAdmin)];
}

export function categoryById(id, isAdmin) {
  return visibleCategories(isAdmin).find((category) => category.id === id) ?? EVERYTHING;
}

/** The commands of one category, as the help card wants them. */
export function commandsIn(categoryId) {
  return Object.entries(HELP)
    .filter(([, entry]) => entry.category === categoryId)
    .map(([name, entry]) => ({ name, usage: entry.usage ?? null, summary: entry.summary }));
}

/** The commands to list: none for the overview, otherwise the chosen category. */
export function helpSections(categoryId, isAdmin) {
  const chosen = categoryById(categoryId, isAdmin);
  if (chosen.id === EVERYTHING.id) return [];
  return [{ category: chosen, commands: commandsIn(chosen.id) }];
}

/** How many commands there are in total, and per category. */
export function helpOverview(isAdmin) {
  const categories = visibleCategories(isAdmin).map((category) => ({ category, count: commandsIn(category.id).length }));
  return { total: categories.reduce((sum, entry) => sum + entry.count, 0), categories };
}
