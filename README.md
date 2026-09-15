<div align="center">

<img src="website/public/favicon.svg" width="96" height="96" alt="Raya logo" />

# Raya

**The Lavalink v4 client that keeps the music playing.**

Fast, resilient and easy to use: players that survive bot restarts, dead nodes and network blips.

[![npm](https://img.shields.io/npm/v/raya.js?color=ff7a45&label=npm)](https://www.npmjs.com/package/raya.js)
[![CI](https://github.com/neuzgg/raya/actions/workflows/ci.yml/badge.svg)](https://github.com/neuzgg/raya/actions/workflows/ci.yml)
[![Lavalink v4](https://img.shields.io/badge/lavalink-v4-ff4d8d)](https://lavalink.dev)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-45d6b5)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-ffb547)](LICENSE)

[**Documentation**](https://neuzgg.github.io/raya/) ·
[Quick start](https://neuzgg.github.io/raya/getting-started/quick-start/) ·
[Live demo](https://neuzgg.github.io/raya/#demo) ·
[Config Builder](https://neuzgg.github.io/raya/tools/config-builder/) ·
[Official bot](bot/)

</div>

---

```js
const player = await raya.join({ guildId, voiceChannelId, textChannelId });
await player.enqueue(await player.search('never gonna give you up', { requester: user }));
```

## Why Raya

| | |
| --- | --- |
| 🔁 **Restart-proof** | `raya.shutdown()` saves every player. The next process resumes the same Lavalink session, so the music doesn't stop while your bot restarts. |
| 🛟 **Self-healing** | v4 session resuming, rebuilds after a Lavalink restart, automatic failover between nodes, and voice reconnects after Discord voice errors. |
| ⚡ **Fast by design** | Changes made in the same tick become one request. Tracks decode locally, searches are cached and de-duplicated, and node balancing is load-aware. |
| 🎶 **Smart autoplay** | YouTube mixes, LavaSrc recommendations, then more from the same artist. Works with Spotify even without Extended quota. |
| 📡 **Live now playing** | Connect your bot to your website: show its avatar, status and the song it's playing, in real time. |
| 🏷️ **Voice channel status** | Shows "Now playing" on the voice channel and cleans it up when playback ends. |
| 🧩 **Any Discord library** | Connectors for discord.js, Eris and Oceanic, or plug in anything with a `send` function. |
| 🧠 **Typed end to end** | Typed events, a typed requester through declaration merging, and errors with stable codes. |

Also included:
- **Queue:** history, previous, shuffle, move, dedupe.
- **Playback:** loop modes, filters with presets, auto-leave on empty channels.
- **Plugins:** LavaLyrics, SponsorBlock and LavaSearch.
- **Lightweight:** one runtime dependency (`ws`).

## Installation

```bash
npm install raya.js
```

You need Node.js 18.17+ and a [Lavalink v4](https://github.com/lavalink-devs/Lavalink) server (or [NodeLink](https://github.com/PerformanC/NodeLink)).

## Quick start

```js
const { Client, GatewayIntentBits } = require('discord.js');
const { Raya, Connectors } = require('raya.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const raya = new Raya({
  nodes: [{ name: 'main', host: 'localhost', port: 2333, password: 'youshallnotpass' }],
  connector: new Connectors.DiscordJS(client), // create before client.login()
  defaultSearchSource: 'youtube',              // or 'spsearch' with LavaSrc
  playerDefaults: { autoplay: true },
  voiceStatus: { template: '🎶 {title} - {author}' },
});

raya.on('trackStart', (player, track) => {
  client.channels.cache.get(player.textChannelId)?.send(`Now playing **${track.info.title}**`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'play') return;

  const player = await raya.join({
    guildId: interaction.guildId,
    voiceChannelId: interaction.member.voice.channelId,
    textChannelId: interaction.channelId,
  });
  const result = await player.search(interaction.options.getString('query'), { requester: interaction.user });
  const { added } = await player.enqueue(result); // starts playing when idle
  await interaction.reply(`Queued ${added.length} track(s)`);
});

client.login(process.env.DISCORD_TOKEN);
```

With [Eris](https://neuzgg.github.io/raya/getting-started/connectors/) use `new Connectors.Eris(client)`, with Oceanic use `new Connectors.Oceanic(client)`. For any other library, pass `send` and forward raw packets to `raya.handleRaw()`.

## A taste of the API

```js
// Playback
await player.skip();
await player.previous();
await player.pause();
await player.seek(60_000);
await player.setVolume(80);          // 0-1000, 100 = original loudness
player.setLoop('queue');             // 'off' | 'track' | 'queue'

// Queue
player.queue.add(tracks);
player.queue.move(5, 0);
player.queue.shuffle();
player.queue.removeWhere((track) => track.requester?.id === userId);

// Filters (calls in the same tick share one request)
await player.filters.bassBoost('high');
await player.filters.nightcore();
await player.filters.setEqualizerPreset('rock');
```

### Restart your bot without stopping the music

```js
// Before exiting (e.g. on SIGINT)
fs.writeFileSync('raya-snapshot.json', JSON.stringify(await raya.shutdown()));

// On start
const restore = fs.existsSync('raya-snapshot.json')
  ? JSON.parse(fs.readFileSync('raya-snapshot.json', 'utf8'))
  : undefined;
const raya = new Raya({ nodes, connector, restore });
```

### Show what your bot is playing on your website

```js
const { NowPlayingFeed } = require('raya.js');

await raya.use(new NowPlayingFeed({
  port: 8787,
  bot: () => ({ name: client.user?.username, avatar: client.user?.displayAvatarURL() }),
}));
// GET /now-playing (JSON) and /now-playing/stream (live updates)
// Only the song is shared: no server names or usernames.
```

## Official bot

[**Raya Bot**](bot/) is a complete music bot built with raya.js and discord.js display components:
- one live player per server, with buttons for playback, loop, autoplay, sound, queue and lyrics
- search suggestions, restart-proof players, and a live now-playing feed for the website

Run it yourself or use it as a starting point. See [`bot/README.md`](bot/README.md). For something smaller, there's also a [minimal example](examples/discordjs-bot.js).

## Documentation

Full docs, guides and interactive tools: **[neuzgg.github.io/raya](https://neuzgg.github.io/raya/)**

| Getting started | Guides | Tools |
| --- | --- | --- |
| [Installation](https://neuzgg.github.io/raya/getting-started/installation/) | [Players](https://neuzgg.github.io/raya/guides/players/) · [Queue](https://neuzgg.github.io/raya/guides/queue/) · [Filters](https://neuzgg.github.io/raya/guides/filters/) | [Config Builder](https://neuzgg.github.io/raya/tools/config-builder/) |
| [Quick start](https://neuzgg.github.io/raya/getting-started/quick-start/) | [Autoplay](https://neuzgg.github.io/raya/guides/autoplay/) · [Voice status](https://neuzgg.github.io/raya/guides/voice-status/) · [Live now playing](https://neuzgg.github.io/raya/guides/live-now-playing/) | [Filter Lab](https://neuzgg.github.io/raya/tools/filter-lab/) |
| [Connectors](https://neuzgg.github.io/raya/getting-started/connectors/) | [Restarts](https://neuzgg.github.io/raya/guides/restarts/) · [Failover](https://neuzgg.github.io/raya/guides/resilience/) · [Debugging](https://neuzgg.github.io/raya/guides/debugging/) | [Event Explorer](https://neuzgg.github.io/raya/tools/event-explorer/) |

## Coming from LavaFlow?

Raya started from LavaFlow's code and fixes its biggest problems:
- **Volume:** 10x too loud (`setVolume(100)` sent 1000).
- **Idle nodes:** dropped after a minute.
- **Resuming:** never worked.
- **Health check:** deleted nodes that were still reconnecting.

See the [migration guide](https://neuzgg.github.io/raya/guides/migrating-from-lavaflow/). Options that moved (like `autoPlay` or `defaultSearchPlatform`) print a warning.

## Development

```bash
npm install
npm run build   # dist/: CommonJS, ESM entry and type declarations
npm test        # unit and integration tests against an in-process Lavalink v4 simulator (Node 22+)
```

The documentation website lives in [`website/`](website/) (Astro + Starlight):

```bash
cd website && npm install && npm run dev
```

## Contributing

Issues and pull requests are welcome. For bugs, include your Raya and Lavalink versions and the output with `debug: true`. Please run `npm test` before opening a pull request.

## License

[MIT](LICENSE) © neuzgg
