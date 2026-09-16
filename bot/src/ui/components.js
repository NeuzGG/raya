import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';
import { safeUrl, truncate } from './format.js';

export { ButtonStyle };

const NO_MENTIONS = { parse: [] };

/**
 * Every Raya message is one card: blocks of text split by divider lines, then the controls.
 * No accent color and no header: the first block is the content itself. With `thumbnail`
 * that first block becomes a section with the cover art beside it.
 *
 * @param {Array<string | null | undefined | false>} blocks
 * @param {Array<ActionRowBuilder | null>} [rows]
 * @param {{ thumbnail?: { url?: string | null, description?: string } }} [options]
 */
export function card(blocks, rows = [], { thumbnail } = {}) {
  const container = new ContainerBuilder();
  const art = safeUrl(thumbnail?.url);
  blocks.filter(Boolean).forEach((content, index) => {
    if (index > 0) container.addSeparatorComponents(divider());
    if (index === 0 && art) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(content))
          .setThumbnailAccessory(
            new ThumbnailBuilder().setURL(art).setDescription(truncate(thumbnail.description || 'Cover art', 100)),
          ),
      );
      return;
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
  });
  const controls = rows.filter((entry) => entry && entry.components.length > 0);
  if (controls.length > 0) {
    container.addSeparatorComponents(divider());
    container.addActionRowComponents(...controls);
  }
  return container;
}

function divider() {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

/** Options for sending a new message or interaction reply. */
export function create(container, { ephemeral = false } = {}) {
  return {
    components: [container],
    flags: ephemeral ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral : MessageFlags.IsComponentsV2,
    allowedMentions: NO_MENTIONS,
  };
}

/** Options for editing a message, updating a button's message or editing a deferred reply. */
export function edit(container) {
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: NO_MENTIONS };
}

/**
 * @param {string} customId
 * @param {{ emoji?: string, label?: string, style?: ButtonStyle, disabled?: boolean }} [options]
 */
export function button(customId, { emoji, label, style = ButtonStyle.Secondary, disabled = false } = {}) {
  const built = new ButtonBuilder().setCustomId(customId).setStyle(style).setDisabled(disabled);
  if (emoji) built.setEmoji(emoji);
  if (label) built.setLabel(label);
  return built;
}

export function linkButton(url, label, emoji) {
  const built = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(label);
  if (emoji) built.setEmoji(emoji);
  return built;
}

/** An action row of up to 5 buttons; falsy entries are skipped. Returns null when empty. */
export function row(...buttons) {
  const list = buttons.flat().filter(Boolean);
  return list.length > 0 ? new ActionRowBuilder().addComponents(list) : null;
}

/**
 * A dropdown in its own row. Options are `{ label, value, description?, emoji?, default? }`,
 * trimmed to Discord's limits (25 options, 100 characters each).
 */
export function select(customId, { placeholder, options, disabled = false } = {}) {
  const list = (options ?? []).filter(Boolean).slice(0, 25);
  if (list.length === 0) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setDisabled(disabled)
    .addOptions(
      list.map((option) => ({
        label: truncate(option.label, 100),
        value: truncate(String(option.value), 100),
        ...(option.description ? { description: truncate(option.description, 100) } : {}),
        ...(option.emoji ? { emoji: option.emoji } : {}),
        ...(option.default ? { default: true } : {}),
      })),
    );
  if (placeholder) menu.setPlaceholder(truncate(placeholder, 150));
  return new ActionRowBuilder().addComponents(menu);
}

/** A simple one-block card. `note` is added as small grey text. */
export function notice(text, { note, rows, thumbnail } = {}) {
  return card([note ? `${text}\n-# ${note}` : text], rows, { thumbnail });
}
