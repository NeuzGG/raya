// Registers the slash commands with Discord.
//
//   npm run deploy                  every server (can take a few minutes to show up)
//   npm run deploy -- --guild <id>  one server, instantly (defaults to DEV_GUILD_ID when set)
//   npm run deploy -- --clear       remove the commands (combine with --guild for one server)
import { REST, Routes } from 'discord.js';
import { commandBodies } from '../src/commands/index.js';
import { ConfigError, loadEnvFile } from '../src/config.js';

loadEnvFile();

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : null;
};

try {
  const token = process.env.DISCORD_TOKEN?.trim();
  if (!token) throw new ConfigError('DISCORD_TOKEN is missing. Copy bot/.env.example to bot/.env and add your bot token.');

  const rest = new REST().setToken(token);
  const application = await rest.get(Routes.currentApplication());
  const guildId = flag('global') ? null : option('guild') || process.env.DEV_GUILD_ID?.trim() || null;
  const body = flag('clear') ? [] : commandBodies();
  const route = guildId ? Routes.applicationGuildCommands(application.id, guildId) : Routes.applicationCommands(application.id);

  const saved = await rest.put(route, { body });
  const where = guildId ? `server ${guildId}` : 'every server';
  console.log(flag('clear') ? `Removed the commands from ${where}.` : `Registered ${saved.length} commands for ${application.name} in ${where}.`);
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : `Deploy failed: ${error.message}`);
  process.exit(1);
}
