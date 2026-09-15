import { create, edit, notice } from '../ui/components.js';
import { handleButton } from './buttons.js';
import { describeError, isUnexpected } from './errors.js';

/** Creates the `interactionCreate` handler for commands, autocomplete and buttons. */
export function createRouter(bot, commands) {
  const byName = new Map(commands.map((command) => [command.data.name, command]));

  return async function route(interaction) {
    if (!interaction.inGuild()) return;
    try {
      if (interaction.isAutocomplete()) {
        await byName.get(interaction.commandName)?.autocomplete?.({ interaction, bot });
      } else if (interaction.isChatInputCommand()) {
        await byName.get(interaction.commandName)?.run({ interaction, bot });
      } else if (interaction.isButton()) {
        await handleButton(interaction, bot);
      }
    } catch (error) {
      await fail(interaction, error, bot.log);
    }
  };
}

async function fail(interaction, error, log) {
  if (isUnexpected(error)) {
    const where = interaction.isButton?.() ? `button ${interaction.customId}` : `/${interaction.commandName}`;
    log.error(`${where} failed:`, error);
  }
  if (interaction.isAutocomplete()) {
    if (!interaction.responded) await interaction.respond([]).catch(() => undefined);
    return;
  }
  const container = notice(describeError(error));
  try {
    if (interaction.deferred && !interaction.replied && !interaction.isButton()) await interaction.editReply(edit(container));
    else if (interaction.deferred || interaction.replied) await interaction.followUp(create(container, { ephemeral: true }));
    else await interaction.reply(create(container, { ephemeral: true }));
  } catch (replyError) {
    log.debug('Could not report an error to the user:', replyError.message);
  }
}
