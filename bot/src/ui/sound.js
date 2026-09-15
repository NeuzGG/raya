import { button, ButtonStyle, card, row } from './components.js';
import { emojis } from './emojis.js';
import { FILTERS, activeFilters, filterLabels } from '../music/filters.js';

export const VOLUME_STEP = 10;

/** Volume and filter presets. Active presets are highlighted. */
export function renderSound(player, { maxVolume = 200 } = {}) {
  const active = new Set(activeFilters(player));
  const labels = filterLabels(player);
  const toggle = (filter) =>
    button(`sound:filter:${filter.id}`, {
      label: filter.label,
      style: active.has(filter.id) ? ButtonStyle.Primary : ButtonStyle.Secondary,
    });

  return card(
    [
      `Volume **${player.volume}%**\n-# ${labels.length ? `Filters: ${labels.join(', ')}` : 'No filters on'} · changes apply for everyone listening`,
    ],
    [
      row(
        button('sound:volume:down', { emoji: emojis.volumeDown, label: `−${VOLUME_STEP}`, disabled: player.volume <= 0 }),
        button('sound:volume:reset', { label: 'Reset to 100%', disabled: player.volume === 100 }),
        button('sound:volume:up', { emoji: emojis.volumeUp, label: `+${VOLUME_STEP}`, disabled: player.volume >= maxVolume }),
      ),
      row(FILTERS.slice(0, 5).map(toggle)),
      row(
        FILTERS.slice(5).map(toggle),
        button('sound:clear', { label: 'Clear filters', style: ButtonStyle.Danger, disabled: active.size === 0 }),
      ),
    ],
  );
}
