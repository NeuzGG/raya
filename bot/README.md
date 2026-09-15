# Raya Bot

The official Raya music bot, built with [raya.js](../README.md) and discord.js [display components](https://discordjs.guide/legacy/popular-topics/display-components).

- **One live player per server.** A single message that updates itself: the song, a countdown to the end, what's up next, and the controls. When a new song starts, the player moves to the bottom of the chat and the old one is removed.
- **Buttons for everything:** previous, pause, skip, shuffle, stop, loop, autoplay, sound board (volume and filters), queue and lyrics.
- **Clean cards:** text and dividers only, with no header and no accent color.
- **Restart-proof:** `Ctrl+C` saves every player and the music keeps playing while the bot restarts.
- **Connected to the website:** the Raya docs site shows the bot and the song it's playing, live.
- **Safe by default:** only people in the bot's voice channel (or server managers) can control the music; song titles can't inject markdown or mentions, and the bot never pings anyone.

## Commands

| Command | |
| --- | --- |
| `/play query [next]` | Play a song, playlist or link, with search suggestions as you type |
| `/nowplaying` | Bring the player to the bottom of the chat |
| `/pause` · `/resume` | Pause or resume |
| `/skip [to]` · `/previous` | Skip, jump to a song in the queue, or go back |
| `/seek time` | `1:30`, `90`, `2m`, `+10` or `-10` |
| `/queue` · `/remove` · `/move` · `/shuffle` | Manage the queue |
| `/loop [mode]` · `/autoplay` | Loop the song or queue, keep playing related songs |
| `/volume [level]` · `/filters [preset]` | Volume (0-200) and bass boost, nightcore, 8D, ... |
| `/lyrics` | Lyrics of the current song (needs LavaLyrics on your Lavalink) |
| `/stop` · `/help` | Stop and leave, or show help |

## Setup

You need Node.js 20.12+ and a Lavalink v4 server.

```bash
# 1. Build raya.js (the bot uses this repo's build until raya.js is on npm)
npm install
npm run build

# 2. Install the bot
cd bot
npm install
```

3. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Under **Bot**, copy the token. No privileged intents are needed.
4. Copy `bot/.env.example` to `bot/.env` and fill it in. `bot/.env` is gitignored: keep your token there and nowhere else.
5. Register the slash commands, then start the bot:

```bash
npm run deploy   # all servers; with DEV_GUILD_ID set, only that server (instant)
npm start        # prints the invite link on startup
```

Invite the bot with the link it prints. It asks for View Channel, Send Messages, Read Message History, Connect, Speak and Set Voice Channel Status.

To restart without stopping the music, press `Ctrl+C` (or send `SIGTERM`) and start the bot again within a minute. Players are saved to `bot/data/snapshot.json` and picked up on the next start.

## Show the bot on the website

With `LIVE_FEED_PORT` set, the bot serves its live status at `http://localhost:8787/now-playing`. It shares only the bot's name, avatar and invite link, plus the song: no server names, channels or users.

1. Put the feed on a public HTTPS address, for example with a Cloudflare tunnel: `cloudflared tunnel --url http://localhost:8787`
2. In the GitHub repo, go to **Settings → Secrets and variables → Actions → Variables** and add `LIVE_FEED_URL` with the address plus `/now-playing`, e.g. `https://example.trycloudflare.com/now-playing`
3. Re-run the **Docs** workflow. The home page now shows the bot live, with an **Add to Discord** button.

`LIVE_FEED_CORS` must match the site's origin (`https://neuzgg.github.io` by default). See the [live now playing guide](https://neuzgg.github.io/raya/guides/live-now-playing/) for details.

## Configuration

Every option is in [`.env.example`](.env.example):

| Variable | Default | |
| --- | --- | --- |
| `DISCORD_TOKEN` | | Required |
| `DEV_GUILD_ID` | | Server used by `npm run deploy` for instant testing |
| `LAVALINK_HOST` `LAVALINK_PORT` `LAVALINK_PASSWORD` `LAVALINK_SECURE` | `localhost` `2333` `youshallnotpass` `false` | One node |
| `LAVALINK_NODES` | | Several nodes as JSON (overrides the four above) |
| `SEARCH_SOURCE` | `youtube` | `spotify`, `applemusic`, `deezer`... need LavaSrc |
| `DEFAULT_VOLUME` | `80` | 1-200 |
| `LEAVE_WHEN_EMPTY_AFTER` | `60` | Seconds, `0` = never. The music pauses while nobody is listening |
| `LEAVE_AFTER_QUEUE_END` | `180` | Seconds, `0` = never |
| `MAX_QUEUE_SIZE` | `1000` | |
| `VOICE_STATUS` | `true` | Show the song as the voice channel status |
| `LIVE_FEED_PORT` `LIVE_FEED_HOST` `LIVE_FEED_CORS` | off, `0.0.0.0`, `https://neuzgg.github.io` | Website feed |
| `WEBSITE_URL` `GITHUB_URL` `SUPPORT_URL` | Raya links | Buttons in `/help` |
| `RAYA_DEBUG` | `false` | Verbose logs |

## Customizing

- **Emojis:** [`src/ui/emojis.js`](src/ui/emojis.js). Upload application emojis in the Developer Portal and use `<:name:id>`.
- **Cards:** every message is built with `card()` in [`src/ui/components.js`](src/ui/components.js). The player lives in [`src/ui/panel.js`](src/ui/panel.js).
- **Commands:** [`src/commands`](src/commands). Run `npm run deploy` after changing names, descriptions or options.

## Development

```bash
npm test   # card rules, formatting, config, and full /play → buttons flows against a Lavalink simulator
npm run dev
```

The flow tests use the Lavalink v4 simulator from the raya.js test suite; `npm test` builds it first.
