import { assertMusicChannel } from '../music/guards.js';
import { create, edit, notice } from '../ui/components.js';
import { handleButton } from './buttons.js';
import { handleSelect } from './selects.js';
import { describeError, isExpiredInteraction, isUnexpected } from './errors.js';

const MUSIC_CATEGORIES = new Set(['music', 'queue', 'sound']);

/** Creates the `interactionCreate` handler for commands, autocomplete and buttons. */
export function createRouter(bot, commands) {
  const byName = new Map(commands.map((command) => [command.data.name, command]));

  return async function route(interaction) {
    if (!interaction.inGuild()) return;
    try {
      if (interaction.isAutocomplete()) {
        await byName.get(interaction.commandName)?.autocomplete?.({ interaction, bot });
      } else if (interaction.isChatInputCommand()) {
        const command = byName.get(interaction.commandName);
        if (!command) return;
        // With /setup, music commands belong in the request channel.
        if (MUSIC_CATEGORIES.has(command.category)) assertMusicChannel(bot, interaction);
        await command.run({ interaction, bot });
      } else if (interaction.isButton()) {
        await handleButton(interaction, bot);
      } else if (interaction.isStringSelectMenu()) {
        await handleSelect(interaction, bot);
      }
    } catch (error) {
      await fail(interaction, error, bot.log);
    }
  };
}

async function fail(interaction, error, log) {
  if (isExpiredInteraction(error)) {
    // Discord only waits three seconds for the first answer, and it had already given up.
    log.warn(`Discord dropped an interaction (${interaction.customId ?? '/' + interaction.commandName}) before it could be answered.`);
    return;
  }
  if (isUnexpected(error)) {
    const where = interaction.customId ? `component ${interaction.customId}` : `/${interaction.commandName}`;
    log.error(`${where} failed:`, error);
  }
  if (interaction.isAutocomplete()) {
    if (!interaction.responded) await interaction.respond([]).catch(() => undefined);
    return;
  }
  const container = notice(describeError(error));
  try {
    if (interaction.deferred && !interaction.replied && !interaction.customId) await interaction.editReply(edit(container));
    else if (interaction.deferred || interaction.replied) await interaction.followUp(create(container, { ephemeral: true }));
    else await interaction.reply(create(container, { ephemeral: true }));
  } catch (replyError) {
    log.debug('Could not report an error to the user:', replyError.message);
  }
}
