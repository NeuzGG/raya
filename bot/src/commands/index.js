import { ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import admin from './admin.js';
import { HELP } from './catalog.js';
import info from './info.js';
import music from './music.js';
import queue from './queue.js';
import setup from './setup.js';
import sound from './sound.js';

export { CATEGORIES, EVERYTHING, HELP, categoryById, commandsIn, dropdownCategories, helpOverview, helpSections, visibleCategories } from './catalog.js';

export const commands = [...music, ...queue, ...sound, ...info, ...admin, ...setup];

for (const command of commands) {
  command.data.setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
  const help = HELP[command.data.name];
  command.category = help?.category ?? null;
  command.usage = help?.usage ?? null;
  command.summary = help?.summary ?? command.data.description;
}

/** JSON bodies for registering the commands with Discord. */
export function commandBodies() {
  return commands.map((command) => command.data.toJSON());
}
