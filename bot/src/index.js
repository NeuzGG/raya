import fs from 'node:fs';
import path from 'node:path';
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  OAuth2Scopes,
  Options,
  PermissionFlagsBits,
} from 'discord.js';
import { Connectors, Raya, VERSION } from '../../dist/index.mjs';
import { commands } from './commands/index.js';
import { ConfigError, loadConfig, loadEnvFile } from './config.js';
import { createRouter } from './interactions/router.js';
import { createLogger } from './logger.js';
import { Panels } from './music/panels.js';
import { Settings } from './music/settings.js';
import { setCommandIds } from './ui/mentions.js';

loadEnvFile();

let config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`Config error: ${error.message}`);
  process.exit(1);
}

const log = createLogger({ debug: config.debug });

const INVITE_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ManageChannels, // /setup creates the music channels
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.SetVoiceChannelStatus,
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // voice channels, and noticing when everyone leaves
    GatewayIntentBits.GuildMessages, // knowing whether the player is still the newest message (no message content)
  ],
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 0,
    ReactionManager: 0,
    GuildEmojiManager: 0,
    GuildStickerManager: 0,
    PresenceManager: 0,
  }),
});

// ==================== Restart without stopping the music ====================

let restore;
if (fs.existsSync(config.snapshotFile)) {
  try {
    restore = JSON.parse(fs.readFileSync(config.snapshotFile, 'utf8'));
    log.info(`Restoring ${restore.players?.length ?? 0} player(s) from the last shutdown`);
  } catch (error) {
    log.warn(`Ignoring unreadable snapshot: ${error.message}`);
  }
  fs.rmSync(config.snapshotFile, { force: true }); // single use, so a crash never restores stale players
}

const raya = new Raya({
  nodes: config.nodes,
  connector: new Connectors.DiscordJS(client), // must be created before client.login()
  clientName: `RayaBot/${VERSION}`,
  defaultSearchSource: config.searchSource,
  restore,
  debug: config.debug ? (message) => log.debug(`[raya] ${message}`) : false,
  voiceStatus: config.voiceStatus
    ? { template: '🎶 {title} · {author}', onError: (error) => log.debug(`Voice status: ${error.message}`) }
    : false,
  playerDefaults: {
    volume: config.player.volume,
    maxQueueSize: config.player.maxQueueSize,
    pauseOnEmpty: true,
    emptyChannelTimeout: config.player.leaveWhenEmptyAfter || false,
    queueEndTimeout: config.player.leaveAfterQueueEnd || false,
  },
  // Keep requesters tiny and serializable so snapshots stay small.
  requesterTransformer: (user) => ({ id: user.id, username: user.username }),
});

raya.on('nodeReady', (node, resumed) => log.info(`Lavalink "${node.name}" ready${resumed ? ' (session resumed)' : ''}`));
raya.on('nodeDisconnect', (node, info) => log.warn(`Lavalink "${node.name}" disconnected (${info.code} ${info.reason || 'no reason'})`));
raya.on('nodeError', (node, error) => log.error(`Lavalink "${node.name}": ${error.message}`));
raya.on('playerError', (player, error) => log.warn(`Player ${player.guildId}: ${error.message}`));

// ==================== Bot ====================

let inviteUrl = null;
const settings = new Settings(config.settingsFile);
const bot = {
  client,
  raya,
  config,
  log,
  settings,
  panels: new Panels({
    client,
    raya,
    log,
    settings,
    emptyLeaveDelay: config.player.leaveWhenEmptyAfter,
    queueEndLeaveDelay: config.player.leaveAfterQueueEnd,
  }).attach(),
  invite: () => inviteUrl,
};

client.on(Events.InteractionCreate, createRouter(bot, commands));

client.once(Events.ClientReady, async (ready) => {
  inviteUrl = ready.generateInvite({ scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands], permissions: INVITE_PERMISSIONS });
  log.info(`Logged in as ${ready.user.tag} in ${ready.guilds.cache.size} server(s)`);
  log.info(`Invite: ${inviteUrl}`);

  try {
    const registered = [...(await ready.application.commands.fetch()).values()];
    if (config.devGuildId) {
      const guild = await ready.guilds.fetch(config.devGuildId).catch(() => null);
      if (guild) registered.push(...(await guild.commands.fetch()).values());
    }
    setCommandIds(registered);
    if (registered.length === 0) log.warn('No slash commands registered yet. Run: npm run deploy');
  } catch (error) {
    log.warn(`Could not fetch slash commands: ${error.message}`);
  }

  updatePresence();
  setInterval(updatePresence, 60_000).unref();
});

function updatePresence() {
  const playing = raya.stats.playingPlayers;
  client.user?.setPresence({
    status: 'online',
    activities: [
      playing > 0
        ? { type: ActivityType.Listening, name: `music in ${playing} ${playing === 1 ? 'server' : 'servers'} · /play` }
        : { type: ActivityType.Listening, name: '/play' },
    ],
  });
}

// ==================== Shutdown ====================

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info(`${signal} received, saving players...`);
  try {
    const snapshot = await raya.shutdown(); // players keep playing on Lavalink while the bot restarts
    if (snapshot.players.length > 0) {
      fs.mkdirSync(path.dirname(config.snapshotFile), { recursive: true });
      fs.writeFileSync(config.snapshotFile, JSON.stringify(snapshot));
      log.info(`Saved ${snapshot.players.length} player(s). Start the bot again within a minute to pick them up.`);
    }
  } catch (error) {
    log.error('Could not save players:', error);
  }
  settings.flush();
  await client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => log.error('Unhandled rejection:', error));

try {
  await client.login(config.token);
} catch (error) {
  log.error(
    error.code === 'TokenInvalid'
      ? 'Discord rejected DISCORD_TOKEN. Reset the token in the Developer Portal (Bot > Reset Token) and put the new one in bot/.env.'
      : `Could not log in to Discord: ${error.message}`,
  );
  await raya.destroy().catch(() => undefined);
  process.exit(1);
}
