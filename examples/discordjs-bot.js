// Minimal music bot with discord.js v14 and Raya.
//
// Never put your token in this file. Copy examples/.env.example to examples/.env, fill it in, then:
//   npm install && npm run build
//   node --env-file=examples/.env examples/discordjs-bot.js
//
// In your own bot: npm install discord.js raya.js, then require('raya.js') instead of '../dist'.

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy examples/.env.example to examples/.env and fill it in.');
  process.exit(1);
}

const fs = require('node:fs');
const { Client, GatewayIntentBits } = require('discord.js');
const { Raya, Connectors } = require('../dist');

const SNAPSHOT_FILE = './raya-snapshot.json';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // required for voice + empty channel detection
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Players from before a restart keep playing while the bot is down and are picked up here.
// Snapshots are single-use: delete after reading so a later crash doesn't restore stale players.
let restore;
if (fs.existsSync(SNAPSHOT_FILE)) {
  restore = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  fs.unlinkSync(SNAPSHOT_FILE);
}

const raya = new Raya({
  nodes: [
    {
      name: 'main',
      host: process.env.LAVALINK_HOST ?? 'localhost',
      port: Number(process.env.LAVALINK_PORT ?? 2333),
      password: process.env.LAVALINK_PASSWORD ?? 'youshallnotpass',
      secure: process.env.LAVALINK_SECURE === 'true',
    },
  ],
  connector: new Connectors.DiscordJS(client), // must be created before client.login()
  restore,
  defaultSearchSource: 'spsearch', // Spotify search (needs LavaSrc on your Lavalink); use 'youtube' otherwise
  voiceStatus: { template: '🎶 {title} - {author}' }, // needs "Set Voice Channel Status" permission
  debug: process.env.RAYA_DEBUG === '1',
  playerDefaults: {
    emptyChannelTimeout: 60_000, // leave 1 minute after everyone left
    pauseOnEmpty: true,
    queueEndTimeout: 120_000,
  },
  // Keep only what you need from the discord.js User so snapshots stay small and serializable.
  requesterTransformer: (user) => ({ id: user.id, username: user.username }),
});

raya.on('nodeReady', (node, resumed) => console.log(`Node ${node.name} ready (resumed: ${resumed})`));
raya.on('nodeError', (node, error) => console.error(`Node ${node.name}:`, error.message));
raya.on('playerError', (player, error) => console.error(`Player ${player.guildId}:`, error.message));

raya.on('trackStart', (player, track) => {
  const channel = player.textChannelId && client.channels.cache.get(player.textChannelId);
  channel?.send?.(`Now playing **${track.info.title}** (requested by ${track.requester?.username ?? 'autoplay'})`);
});

raya.on('queueEnd', (player) => {
  const channel = player.textChannelId && client.channels.cache.get(player.textChannelId);
  channel?.send?.('Queue finished.');
});

const format = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith('!')) return;
  const [command, ...args] = message.content.slice(1).trim().split(/\s+/);
  const player = raya.getPlayer(message.guild.id);

  try {
    switch (command) {
      case 'play': {
        const voiceChannelId = message.member?.voice.channelId;
        if (!voiceChannelId) return void message.reply('Join a voice channel first.');
        const joined = await raya.join({ guildId: message.guild.id, voiceChannelId, textChannelId: message.channel.id });
        const result = await joined.search(args.join(' '), { requester: message.author });
        if (result.type === 'error') return void message.reply(`Failed: ${result.exception?.message}`);
        if (result.tracks.length === 0) return void message.reply('Nothing found.');
        const { added } = await joined.enqueue(result);
        return void message.reply(
          result.type === 'playlist'
            ? `Queued ${added.length} tracks from **${result.playlist.name}**`
            : `Queued **${added[0].info.title}**`,
        );
      }
      case 'skip':
        await player?.skip();
        return;
      case 'pause':
        await player?.pause(!player.paused);
        return;
      case 'stop':
        await player?.destroy();
        return;
      case 'volume':
        await player?.setVolume(Number(args[0]));
        return;
      case 'loop':
        player?.setLoop(args[0] ?? 'off');
        return;
      case 'shuffle':
        player?.queue.shuffle();
        return;
      case 'autoplay':
        player?.setAutoplay(!player.autoplay);
        return void message.reply(`Autoplay ${player?.autoplay ? 'on' : 'off'}`);
      case 'filter': {
        if (!player) return;
        const filter = args[0];
        if (filter === 'bass') await player.filters.bassBoost('high');
        else if (filter === 'nightcore') await player.filters.nightcore();
        else if (filter === '8d') await player.filters.eightD();
        else await player.filters.clear();
        return;
      }
      case 'np':
        if (!player?.current) return void message.reply('Nothing playing.');
        return void message.reply(`**${player.current.info.title}** ${format(player.position)} / ${format(player.current.info.length)}`);
      case 'queue':
        if (!player) return;
        return void message.reply(
          player.queue.slice(0, 10).map((t, i) => `${i + 1}. ${t.info.title}`).join('\n') || 'Queue is empty.',
        );
    }
  } catch (error) {
    message.reply(`Error: ${error.message}`).catch(() => undefined);
  }
});

// Graceful restart: save players, close Lavalink connections without stopping the music.
async function shutdown() {
  const snapshot = await raya.shutdown();
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot));
  await client.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(process.env.DISCORD_TOKEN);
