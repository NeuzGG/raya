import { ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import info from './info.js';
import music from './music.js';
import queue from './queue.js';
import sound from './sound.js';

export const commands = [...music, ...queue, ...sound, ...info];

for (const command of commands) {
  command.data.setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
}

/** JSON bodies for registering the commands with Discord. */
export function commandBodies() {
  return commands.map((command) => command.data.toJSON());
}
