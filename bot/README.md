# Raya Bot

The official Raya music bot, built with [raya.js](../README.md) and discord.js [display components](https://discordjs.guide/legacy/popular-topics/display-components).

- **One live player per server.** A single message that updates itself: the song with its cover art, a countdown to the end, what's up next, and the controls. When a new song starts, the player moves to the bottom of the chat and the old one is removed.
- **Buttons for everything:** previous, pause, skip, shuffle, stop, loop, autoplay, sound board (volume and filters), queue and lyrics.
- **Clean cards:** text and dividers only, cover art beside the song, and no header or accent color.
- **A /help that explains itself:** how many commands there are and where they live, what's new, a dropdown that opens each category (admin commands only for server managers), and buttons to add the bot, open the website or GitHub.
- **A queue you can steer:** cover art, who added what, paging, shuffle, clear, and a dropdown to jump straight to a song.
- **`/setup` song requests:** one command creates a category, a request channel and a voice channel. In that channel people **just type a song name or paste a link** and it plays: the request is tidied away, and the dashboard message *is* the player, with big cover art, the next five songs, how long the queue runs, when it ends, who is listening and every control. It never gets deleted and goes back to an idle card when the music stops. `/setup delete` removes the channels again, after a confirmation.
- **DJ role:** `/dj set` keeps skips, stops and sound changes to your DJs, while everyone can still add songs.
- **Restart-proof:** `Ctrl+C` saves every player and the music keeps playing while the bot restarts.
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
| `/stop` · `/help` · `/ping` | Stop and leave, show the help menu, or check latency |
| `/stats` | Bot, player and music server numbers |
| `/setup create` · `/setup delete` | Server managers only: make the song request channel, or delete it again (`status` and `disable` too) |
| `/dj set` · `/dj clear` | Server managers only: pick who may skip, stop and change the sound |
| `/reset` · `/summon` | Server managers only: force the player to stop, or move the bot to your channel |

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

3. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Under **Bot**, copy the token and turn on the **Message Content** intent, which song requests need. (Without it, set `SONG_REQUESTS=false` and people use `/play` instead.)
4. Copy `bot/.env.example` to `bot/.env` and fill it in. `bot/.env` is gitignored: keep your token there and nowhere else.
5. Register the slash commands, then start the bot:

```bash
npm run deploy   # all servers; with DEV_GUILD_ID set, only that server (instant)
npm start        # prints the invite link on startup
```

Invite the bot with the link it prints. It asks for View Channel, Send Messages, Read Message History, Connect, Speak, Set Voice Channel Status, and Manage Channels (only used by `/setup`).

To restart without stopping the music, press `Ctrl+C` (or send `SIGTERM`) and start the bot again within a minute. Players are saved to `bot/data/snapshot.json` and picked up on the next start.

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
| `SONG_REQUESTS` | `true` | Play what people type in the `/setup` channel (needs the Message Content intent) |
| `WEBSITE_URL` `GITHUB_URL` `SUPPORT_URL` | Raya links | Buttons in `/help` |
| `RAYA_DEBUG` | `false` | Verbose logs |

## Customizing

- **Emojis:** [`src/ui/emojis.js`](src/ui/emojis.js). Upload application emojis in the Developer Portal and use `<:name:id>`.
- **Announcements:** [`src/announcements.js`](src/announcements.js) feeds the top of `/help`, or set `ANNOUNCEMENT` in `bot/.env` for a one-off notice.
- **Help menu:** [`src/commands/catalog.js`](src/commands/catalog.js) holds the categories and one row per command. Add a row when you add a command; the tests check that nothing is missing.
- **Cards:** every message is built with `card()` in [`src/ui/components.js`](src/ui/components.js). The player lives in [`src/ui/panel.js`](src/ui/panel.js).
- **Commands:** [`src/commands`](src/commands). Run `npm run deploy` after changing names, descriptions or options.

## Development

```bash
npm test   # card rules, formatting, config, and full /play → buttons flows against a Lavalink simulator
npm run dev
```

The flow tests use the Lavalink v4 simulator from the raya.js test suite; `npm test` builds it first.
