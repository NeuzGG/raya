import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';

export { ButtonStyle };

const NO_MENTIONS = { parse: [] };

/**
 * Every Raya message is one card: blocks of text split by divider lines, then button rows.
 * No accent color and no header: the first block is the content itself.
 *
 * @param {Array<string | null | undefined | false>} blocks
 * @param {Array<ActionRowBuilder | null>} [rows]
 */
export function card(blocks, rows = []) {
  const container = new ContainerBuilder();
  blocks.filter(Boolean).forEach((content, index) => {
    if (index > 0) container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
  });
  const buttons = rows.filter((row) => row && row.components.length > 0);
  if (buttons.length > 0) {
    container.addSeparatorComponents(divider());
    container.addActionRowComponents(...buttons);
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

/** A simple one-block card. `note` is added as small grey text. */
export function notice(text, { note, rows } = {}) {
  return card([note ? `${text}\n-# ${note}` : text], rows);
}
