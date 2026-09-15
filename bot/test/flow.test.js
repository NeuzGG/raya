// End to end: slash commands and buttons against Raya and the in-process Lavalink v4 simulator
// from the raya.js test suite (built by `npm run pretest`).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ButtonStyle } from 'discord.js';
import { commands } from '../src/commands/index.js';
import { createRouter } from '../src/interactions/router.js';
import { Panels } from '../src/music/panels.js';
import { assertCard, buttonById, buttons, text } from './helpers/cards.js';
import { click, createDiscord, GUILD_ID, OTHER_VOICE_ID, slash, STRANGER, TEXT_ID, USER, VOICE_ID } from './helpers/discord.js';

const require = createRequire(import.meta.url);
const { MockLavalink } = require('../../build/test/helpers/MockLavalink.js');
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
    bot = {
      client: discord.client,
      raya: harness.raya,
      config: { player: { maxVolume: 200 }, links: {} },
      log: { ...silent, error: (...args) => logged.push(args) },
      logged,
      invite: () => null,
      panels: new Panels({ client: discord.client, raya: harness.raya, log: silent }).attach(),
    };
    route = createRouter(bot, commands);
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

    // Anyone may look at the queue.
    const look = await run(click(discord, panelMessage(), 'player:queue', { user: STRANGER }));
    assert.match(text(look.ephemeralReplies[0].payload), /The queue is empty/);
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

  it('adds playlists and pages through the queue', async () => {
    await run(slash(discord, 'play', { query: 'now playing' }));
    await waitFor(() => player()?.current);
    const playlist = await run(slash(discord, 'play', { query: 'https://example.com/playlist' }));
    assert.match(text(playlist.replyMessage.payload), /^Added \*\*3 songs\*\* from \*\*Mock Playlist\*\*/);

    const view = await run(slash(discord, 'queue'));
    const board = view.ephemeralReplies[0];
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
});
