/**
 * Filter presets shown on the sound board. Active presets are stored in `player.data`, which
 * Raya includes in snapshots, so they survive bot restarts together with the filters themselves.
 */
export const FILTERS = [
  { id: 'bass', label: 'Bass boost', apply: (player, on) => player.filters.bassBoost(on ? 'high' : 'off') },
  { id: 'nightcore', label: 'Nightcore', group: 'speed', apply: (player, on) => player.filters.nightcore(on) },
  { id: 'vaporwave', label: 'Vaporwave', group: 'speed', apply: (player, on) => player.filters.vaporwave(on) },
  { id: '8d', label: '8D', apply: (player, on) => player.filters.eightD(on) },
  { id: 'karaoke', label: 'Karaoke', apply: (player, on) => player.filters.karaoke(on) },
  { id: 'soft', label: 'Soft', apply: (player, on) => player.filters.soft(on) },
  { id: 'tremolo', label: 'Tremolo', apply: (player, on) => player.filters.tremolo(on) },
  { id: 'vibrato', label: 'Vibrato', apply: (player, on) => player.filters.vibrato(on) },
];

const byId = new Map(FILTERS.map((filter) => [filter.id, filter]));

export function activeFilters(player) {
  const stored = player.data.get('filters');
  return Array.isArray(stored) ? stored.filter((id) => byId.has(id)) : [];
}

export function filterLabels(player) {
  return activeFilters(player).map((id) => byId.get(id).label);
}

/** Turn a preset on or off. Presets in the same group replace each other. */
export async function setFilter(player, id, enabled) {
  const filter = byId.get(id);
  if (!filter) throw new Error(`Unknown filter "${id}"`);
  await filter.apply(player, enabled);
  let active = activeFilters(player).filter((other) => other !== id);
  if (enabled) {
    if (filter.group) active = active.filter((other) => byId.get(other).group !== filter.group);
    active.push(id);
  }
  player.data.set('filters', active);
  return enabled;
}

export function toggleFilter(player, id) {
  return setFilter(player, id, !activeFilters(player).includes(id));
}

export async function clearFilters(player) {
  await player.filters.clear();
  player.data.set('filters', []);
}
