// End to end: slash commands and buttons against Raya and the in-process Lavalink v4 simulator
// from the raya.js test suite (built by `npm run pretest`).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ButtonStyle } from 'discord.js';
import { commands } from '../src/commands/index.js';
import { createRouter } from '../src/interactions/router.js';
import { Panels } from '../src/music/panels.js';
import { attachSongRequests } from '../src/music/requests.js';
import { MemorySettings } from '../src/music/settings.js';
import { assertCard, buttonById, buttons, menu, text, thumbnail } from './helpers/cards.js';
import { choose, click, createDiscord, GUILD_ID, OTHER_VOICE_ID, slash, STRANGER, TEXT_ID, USER, VOICE_ID } from './helpers/discord.js';

const require = createRequire(import.meta.url);
const { MockLavalink, makeTrack } = require('../../build/test/helpers/MockLavalink.js');
const { BOT_ID, createHarness, waitFor } = require('../../build/test/helpers/harness.js');

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('bot flow', () => {
  let mock;
  let harness;
  let discord;
  let bot;
  let route;

  beforeEach(async () => {
    mock = await MockLavalink.start();
    harness = createHarness([mock], {
      playerDefaults: { volume: 80 },
      requesterTransformer: (user) => ({ id: user.id, username: user.username }),
    });
    await harness.raya.init(BOT_ID);
    discord = createDiscord();
    const logged = [];
    const settings = new MemorySettings();
    bot = {
      client: discord.client,
      raya: harness.raya,
      config: { player: { maxVolume: 200 }, links: { github: 'https://github.com/neuzgg/raya' }, announcement: null },
      log: { ...silent, error: (...args) => logged.push(args) },
      logged,
      settings,
      invite: () => null,
      panels: new Panels({ client: discord.client, raya: harness.raya, log: silent, settings }).attach(),
    };
    route = createRouter(bot, commands);
    attachSongRequests(bot);
    discord.join(USER);
  });

  afterEach(async () => {
    await harness.raya.destroy();
    await mock.stop();
    assert.deepEqual(bot.logged, [], 'no unexpected errors were logged');
  });

  const run = async (interaction) => {
    await route(interaction);
    return interaction;
  };
  const player = () => harness.raya.getPlayer(GUILD_ID);
  const panelMessage = () => discord.text.store.get(player().data.get('panel')?.messageId);

  it('turns the /play reply into the live player and keeps one player message', async () => {
    const first = await run(slash(discord, 'play', { query: 'first song' }));
    await waitFor(() => player()?.data.get('panel'), 3000, 'panel');

    assert.equal(discord.text.visible.length, 1, 'the reply itself became the player');
    const panel = panelMessage();
    assert.equal(panel, first.replyMessage);
    assertCard(panel.payload);
    assert.match(text(panel.payload), /\*\*\[first song 1\]/);
    assert.match(text(panel.payload), /Requested by <@400000000000000004>/);
    assert.equal(player().voiceChannelId, VOICE_ID);
    assert.equal(player().volume, 80);

    const second = await run(slash(discord, 'play', { query: 'second song' }));
    assert.match(text(second.replyMessage.payload), /^Added \[second song 1\].*\n-# 3:00 · plays next$/);
    await waitFor(() => /Up next \[second song 1\]/.test(text(panelMessage().payload)), 3000, 'panel shows up next');

    const pause = await run(click(discord, panelMessage(), 'player:toggle'));
    assert.equal(player().paused, true);
    assert.equal(buttonById(pause.message.payload, 'player:toggle').emoji.name, '▶️');
    await run(click(discord, panelMessage(), 'player:toggle'));
    assert.equal(player().paused, false);

    // The /play reply for the second song is newer than the player, so the next song moves the player down.
    const oldPanelId = panelMessage().id;
    await run(click(discord, panelMessage(), 'player:skip'));
    await waitFor(() => player().current?.info.title === 'second song 1' && panelMessage()?.id !== oldPanelId, 3000, 'player moved');
    await waitFor(() => /\*\*\[second song 1\]/.test(text(panelMessage().payload)), 3000, 'new song shown');
    assert.ok(discord.text.deleted.includes(oldPanelId), 'the old player message was removed');
    assert.equal(discord.text.visible.filter((m) => buttons(m.payload).some((b) => b.custom_id === 'player:toggle')).length, 1);
    assert.equal(discord.text.lastMessageId, panelMessage().id);

    // Still the newest message: the next state is an edit in place.
    const id = panelMessage().id;
    mock.finishTrack(GUILD_ID);
    await waitFor(() => /The queue has ended/.test(text(panelMessage()?.payload ?? { components: [] })), 3000, 'queue ended card');
    assert.equal(panelMessage().id, id);
    assertCard(panelMessage().payload);

    await run(click(discord, panelMessage(), 'player:leave'));
    await waitFor(() => !harness.raya.getPlayer(GUILD_ID), 3000, 'player destroyed');
    const goodbye = discord.text.store.get(id);
    await waitFor(() => /^Stopped the music and left the voice channel/.test(text(goodbye.payload)), 3000, 'goodbye');
    assert.match(text(goodbye.payload), /Played 2 songs · .* · Stopped by <@400000000000000004>/);
    assert.equal(buttons(goodbye.payload).length, 0);
  });

  it('only lets people in the voice channel control the music', async () => {
    await run(slash(discord, 'play', { query: 'guarded song' }));
    await waitFor(() => player()?.data.get('panel'));

    const outsider = await run(click(discord, panelMessage(), 'player:stop', { user: STRANGER }));
    assert.equal(outsider.ephemeralReplies.length, 1);
    assert.match(text(outsider.ephemeralReplies[0].payload), /Join <#300000000000000003> to control the music/);
    assert.ok(player() && !player().destroyed, 'still playing');

    discord.join(STRANGER, { id: OTHER_VOICE_ID });
    const elsewhere = await run(slash(discord, 'skip', {}, { user: STRANGER }));
    assert.match(text(elsewhere.ephemeralReplies[0].payload), /Join <#300000000000000003>/);

    // Anyone may look at the queue, and it stays in the chat for everyone.
    const look = await run(click(discord, panelMessage(), 'player:queue', { user: STRANGER }));
    assert.deepEqual(look.ephemeralReplies, [], 'the queue is public');
    assert.match(text(look.replyMessage.payload), /The queue is empty/);
  });

  it('explains problems instead of failing silently', async () => {
    discord.leave(USER);
    const noVoice = await run(slash(discord, 'play', { query: 'anything' }));
    assert.match(text(noVoice.ephemeralReplies[0].payload), /Join a voice channel first/);

    discord.join(USER);
    const broken = await run(slash(discord, 'play', { query: 'error please' }));
    assert.match(text(broken.replyMessage.payload), /Couldn't load that: Load failed/);

    const nothing = await run(slash(discord, 'pause'));
    assert.match(text(nothing.ephemeralReplies[0].payload), /Nothing is playing/);
    assert.equal(harness.raya.getPlayer(GUILD_ID), undefined);
  });

  it('adds playlists with their cover and pages through the queue', async () => {
    mock.loadHandler = (identifier) => {
      if (identifier === 'https://example.com/playlist') {
        return {
          loadType: 'playlist',
          data: {
            info: { name: 'Mock Playlist', selectedTrack: -1 },
            pluginInfo: { artworkUrl: 'https://i.scdn.co/image/playlist.png' },
            tracks: [1, 2, 3].map((i) => makeTrack(`Playlist Song ${i}`, { identifier: `pl-${i}` })),
          },
        };
      }
      const query = identifier.replace(/^\w+:/, '');
      return { loadType: 'search', data: [1, 2, 3].map((i) => makeTrack(`${query} ${i}`, { identifier: `${query}-${i}` })) };
    };

    await run(slash(discord, 'play', { query: 'now playing' }));
    await waitFor(() => player()?.current);
    const playlist = await run(slash(discord, 'play', { query: 'https://example.com/playlist' }));
    assert.match(text(playlist.replyMessage.payload), /^Added \*\*3 songs\*\* from \*\*Mock Playlist\*\*/);
    assert.equal(
      thumbnail(playlist.replyMessage.payload).media.url,
      'https://i.scdn.co/image/playlist.png',
      "the playlist's own cover is used",
    );

    const view = await run(slash(discord, 'queue'));
    const board = view.replyMessage;
    assert.deepEqual(view.ephemeralReplies, [], 'the queue is public');
    assertCard(board.payload);
    assert.match(text(board.payload), /`1` \[Playlist Song 1\]/);

    await run(click(discord, board, 'queue:clear:0'));
    assert.match(text(board.payload), /Clear all 3 songs from the queue\?/);
    await run(click(discord, board, 'queue:clear-confirm'));
    assert.equal(player().queue.size, 0);
    assert.match(text(board.payload), /The queue is empty/);
  });

  it('changes the sound from the sound board and keeps the player in sync', async () => {
    await run(slash(discord, 'play', { query: 'loud song' }));
    await waitFor(() => player()?.data.get('panel'));

    const open = await run(click(discord, panelMessage(), 'player:sound'));
    const board = open.ephemeralReplies[0];
    await run(click(discord, board, 'sound:volume:up'));
    assert.equal(player().volume, 90);
    await run(click(discord, board, 'sound:filter:nightcore'));
    assert.equal(buttonById(board.payload, 'sound:filter:nightcore').style, ButtonStyle.Primary);
    await waitFor(() => mock.player(GUILD_ID)?.filters.timescale?.speed === 1.1, 3000, 'nightcore on Lavalink');
    await waitFor(() => /Volume 90% · Nightcore/.test(text(panelMessage().payload)), 3000, 'panel shows the sound settings');

    await run(slash(discord, 'filters', { preset: 'clear' }));
    await waitFor(() => mock.player(GUILD_ID)?.filters.timescale === undefined, 3000, 'filters cleared');
  });

  it('seeks, loops and jumps within the queue', async () => {
    await run(slash(discord, 'play', { query: 'long song' }));
    await run(slash(discord, 'play', { query: 'song two' }));
    await run(slash(discord, 'play', { query: 'song three' }));
    await waitFor(() => player()?.queue.size === 2);

    const seek = await run(slash(discord, 'seek', { time: '1:30' }));
    assert.match(text(seek.replyMessage.payload), /Jumped to `1:30` of `3:00`/);
    await waitFor(() => mock.player(GUILD_ID)?.position >= 90_000, 3000, 'seek sent');

    await run(slash(discord, 'loop', {}));
    assert.equal(player().loop, 'queue');

    const skip = await run(slash(discord, 'skip', { to: 2 }));
    assert.match(text(skip.replyMessage.payload), /Skipped to \[song three 1\]/);
    await waitFor(() => player().current?.info.title === 'song three 1', 3000, 'jumped');
    assert.equal(TEXT_ID, player().textChannelId);
  });

  it('answers /help in the channel, and only its owner can switch category', async () => {
    const help = await run(slash(discord, 'help'));
    const message = help.replyMessage;

    assert.deepEqual(help.ephemeralReplies, [], 'help is public');
    assert.ok(discord.text.visible.includes(message), 'it stays in the chat for everyone');
    assertCard(message.payload);
    const content = text(message.payload);
    assert.ok(content.includes('**Raya** · music that never stops'));
    assert.ok(content.includes('The official Raya bot is here'), 'the announcement is shown');
    assert.ok(content.includes(`**Raya has ${commands.length - 4} commands!**`), content);
    assert.ok(content.includes('🎵 **Music** · 8 commands'));
    assert.ok(!content.includes('`/play`'), 'the list waits behind the dropdown');
    assert.equal(thumbnail(message.payload).media.url, 'https://cdn.discordapp.com/avatars/1/abc.png');
    assert.deepEqual(
      buttons(message.payload).filter((control) => control.style === ButtonStyle.Link).map((link) => link.label),
      ['GitHub'],
    );

    const dropdown = menu(message.payload);
    assert.equal(dropdown.custom_id, `help:${USER.id}`);
    assert.deepEqual(dropdown.options.map((option) => option.value), ['all', 'music', 'queue', 'sound', 'info'], 'no admin category');

    await run(choose(discord, message, dropdown.custom_id, 'sound'));
    assert.ok(text(message.payload).includes('🎛️ **Sound**'), 'the same message switched category');

    const other = await run(choose(discord, message, dropdown.custom_id, 'queue', { user: STRANGER }));
    assert.equal(other.ephemeralReplies.length, 1);
    assert.ok(text(other.ephemeralReplies[0].payload).includes('belongs to someone else'));
    assert.ok(text(message.payload).includes('🎛️ **Sound**'), 'and left the card alone');
  });

  it('shows cover art and jumps to a song from the queue dropdown', async () => {
    mock.loadHandler = (identifier) => ({
      loadType: 'search',
      data: [1, 2, 3].map((i) =>
        makeTrack(`${identifier.replace(/^\w+:/, '')} ${i}`, {
          identifier: `art-${i}-${Math.random().toString(36).slice(2, 8)}`,
          artworkUrl: 'https://i.scdn.co/image/cover.png',
        }),
      ),
    });

    await run(slash(discord, 'play', { query: 'first' }));
    await waitFor(() => player()?.data.get('panel'), 3000, 'panel');
    assert.equal(thumbnail(panelMessage().payload).media.url, 'https://i.scdn.co/image/cover.png', 'the song cover is on the player');

    const added = await run(slash(discord, 'play', { query: 'second' }));
    assert.equal(thumbnail(added.replyMessage.payload).media.url, 'https://i.scdn.co/image/cover.png', 'and on the added card');
    await run(slash(discord, 'play', { query: 'third' }));
    await waitFor(() => player().queue.size === 2);

    const view = await run(slash(discord, 'queue'));
    const board = view.replyMessage;
    const jump = menu(board.payload);
    assert.equal(jump.custom_id, 'queue:jump:0');

    await run(choose(discord, board, jump.custom_id, '2'));
    await waitFor(() => player().current?.info.title === 'third 1', 3000, 'jumped to the second song in the queue');
    assert.ok(text(board.payload).includes('Jumped to [third 1]'), text(board.payload));
  });

  it('sets up a request channel whose dashboard becomes the player', async () => {
    await run(slash(discord, 'setup', {}, { subcommand: 'create', manager: true }));
    const setup = bot.settings.setup(GUILD_ID);
    assert.ok(setup.categoryId && setup.textChannelId && setup.voiceChannelId, 'category, text and voice channels were created');

    const home = discord.channel(setup.textChannelId);
    const dashboard = home.store.get(setup.messageId);
    assertCard(dashboard.payload);
    assert.ok(text(dashboard.payload).includes('**Raya** · nothing is playing'));
    assert.ok(text(dashboard.payload).includes(`Join <#${setup.voiceChannelId}> and **send a song name or a link**`), 'it says how to play');

    // Music commands belong in the request channel now.
    const elsewhere = await run(slash(discord, 'play', { query: 'wrong room' }));
    assert.match(text(elsewhere.ephemeralReplies[0].payload), new RegExp(`Use <#${setup.textChannelId}> for music commands`));
    assert.equal(harness.raya.getPlayer(GUILD_ID), undefined, 'nothing started');

    // In the request channel the dashboard turns into the player, in place.
    await run(slash(discord, 'play', { query: 'dash song' }, { channelId: setup.textChannelId }));
    await waitFor(() => text(dashboard.payload).includes('dash song 1'), 3000, 'the dashboard became the player');
    assert.equal(home.store.get(setup.messageId), dashboard, 'the same message is reused');
    assert.equal(
      home.visible.filter((message) => text(message.payload).includes('dash song 1')).length,
      2,
      'the dashboard plus the /play reply',
    );

    await run(slash(discord, 'stop', {}, { channelId: setup.textChannelId }));
    await waitFor(() => text(dashboard.payload).includes('nothing is playing'), 3000, 'back to the idle dashboard');
    assert.equal(home.deleted.length, 0, 'the dashboard is never deleted');
  });

  it('plays whatever people type in the request channel', async () => {
    await run(slash(discord, 'setup', {}, { subcommand: 'create', manager: true }));
    const setup = bot.settings.setup(GUILD_ID);
    const home = discord.channel(setup.textChannelId);
    const dashboard = home.store.get(setup.messageId);

    const request = await discord.request(setup.textChannelId, 'lofi beats');
    await waitFor(() => player()?.current?.info.title === 'lofi beats 1', 3000, 'the request started playing');
    assert.equal(request.deleted, true, 'the request itself is tidied away');
    await waitFor(() => text(dashboard.payload).includes('lofi beats 1'), 3000, 'the dashboard became the player');
    assert.ok(text(dashboard.payload).includes('**Up next**'), 'and shows what is next');

    // A second request joins the queue and gets a short confirmation.
    await discord.request(setup.textChannelId, 'second request');
    await waitFor(() => player().queue.size === 1, 3000, 'queued');
    const confirmations = home.visible.filter((message) => text(message.payload).includes('second request 1'));
    assert.equal(confirmations.length, 1, confirmations.map((m) => text(m.payload)).join(' | '));

    // Anywhere else, a message is just a message.
    await discord.request(TEXT_ID, 'not a request');
    assert.equal(player().queue.size, 1, 'nothing was added from another channel');
    assert.equal(discord.text.visible.length, 0, 'and nothing was posted there');
  });

  it('deletes the channels it made, but only after a confirmation', async () => {
    await run(slash(discord, 'setup', {}, { subcommand: 'create', manager: true }));
    const setup = bot.settings.setup(GUILD_ID);

    const cancelled = await run(slash(discord, 'setup', {}, { subcommand: 'delete', manager: true }));
    assert.match(text(cancelled.replyMessage.payload), /Delete \*\*raya-requests\*\*/);
    assert.ok(bot.settings.setup(GUILD_ID), 'asking does not delete anything');

    await run(click(discord, cancelled.replyMessage, 'setup:keep', { manager: true }));
    assert.ok(bot.settings.setup(GUILD_ID), 'cancel keeps the channels');
    assert.ok(discord.channel(setup.textChannelId), 'and the channel itself');

    const confirmed = await run(slash(discord, 'setup', {}, { subcommand: 'delete', manager: true }));
    await run(click(discord, confirmed.replyMessage, 'setup:delete', { manager: true }));

    assert.equal(bot.settings.setup(GUILD_ID), null, 'the setup is forgotten');
    for (const id of [setup.textChannelId, setup.voiceChannelId, setup.categoryId]) {
      assert.equal(discord.channel(id), undefined, `channel ${id} was deleted`);
    }

    // Music commands work anywhere again.
    await run(slash(discord, 'play', { query: 'free again' }));
    await waitFor(() => player()?.current?.info.title === 'free again 1', 3000, 'playing outside the old channel');
  });

  it('tells someone who is not in a voice channel what to do', async () => {
    await run(slash(discord, 'setup', {}, { subcommand: 'create', manager: true }));
    const setup = bot.settings.setup(GUILD_ID);
    const home = discord.channel(setup.textChannelId);
    discord.leave(USER);

    await discord.request(setup.textChannelId, 'song without voice');
    assert.equal(harness.raya.getPlayer(GUILD_ID), undefined, 'nothing started');
    const notices = home.visible.filter((message) => text(message.payload).includes('join a voice channel first'));
    assert.equal(notices.length, 1, home.visible.map((m) => text(m.payload)).join(' | '));
  });

  it('lets only DJs change the music once a DJ role is set', async () => {
    const DJ_ROLE = '700000000000000007';
    await run(slash(discord, 'dj', { role: { id: DJ_ROLE } }, { subcommand: 'set', manager: true }));
    assert.equal(bot.settings.get(GUILD_ID).djRoleId, DJ_ROLE);

    // Anyone can still add songs.
    await run(slash(discord, 'play', { query: 'dj song' }));
    await run(slash(discord, 'play', { query: 'another song' }));
    await waitFor(() => player()?.queue.size === 1);

    const denied = await run(slash(discord, 'skip'));
    assert.match(text(denied.ephemeralReplies[0].payload), new RegExp(`Only <@&${DJ_ROLE}> can change the music`));
    assert.equal(player().current?.info.title, 'dj song 1', 'still playing');

    const allowed = await run(slash(discord, 'skip', {}, { roles: [DJ_ROLE] }));
    assert.match(text(allowed.replyMessage.payload), /Skipped \[dj song 1\]/);

    await run(slash(discord, 'dj', {}, { subcommand: 'clear', manager: true }));
    assert.equal(bot.settings.get(GUILD_ID).djRoleId, undefined);
  });

  it('reports bot, player and node numbers', async () => {
    await run(slash(discord, 'play', { query: 'counted song' }));
    await waitFor(() => player()?.current);

    const stats = await run(slash(discord, 'stats'));
    const card = stats.replyMessage.payload;
    assertCard(card);
    const content = text(card);
    assert.ok(content.includes('Playing in 1 server of 1'), content);
    assert.ok(content.includes('1 player'), content);
    assert.ok(content.includes('**Music servers**'));
    assert.ok(content.includes('**node1**'), 'the Lavalink node is listed');
    assert.ok(content.includes('gateway 42ms'));
  });
});
