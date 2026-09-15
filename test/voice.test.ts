import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockLavalink } from './helpers/MockLavalink';
import { BOT_ID, GUILD_ID, OTHER_VOICE_ID, USER_ID, VOICE_ID, createHarness, delay, nextEvent, waitFor } from './helpers/harness';
import type { RayaError } from '../src/utils/errors';
import type { RayaOptions } from '../src/types/raya';

describe('voice', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
    cleanups.length = 0;
  });

  async function setup(options: Partial<RayaOptions> = {}, count = 1) {
    const mocks = await Promise.all(Array.from({ length: count }, () => MockLavalink.start()));
    const h = createHarness(mocks, options);
    cleanups.push(async () => {
      await h.raya.destroy();
      for (const mock of mocks) await mock.stop();
    });
    await h.raya.init(BOT_ID);
    return { mock: mocks[0]!, mocks, h };
  }

  it('destroys the player when the bot is kicked from voice', async () => {
    const { mock, h } = await setup();
    const player = await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    await player.setVolume(80);
    const moved = nextEvent(h.raya, 'playerMove');
    const destroyed = nextEvent(h.raya, 'playerDestroy');
    h.raya.handleRaw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: GUILD_ID, user_id: BOT_ID, session_id: 'x', channel_id: null } });
    assert.deepEqual((await moved).slice(1), [VOICE_ID, null]);
    assert.equal((await destroyed)[1], 'voiceDisconnected');
    await waitFor(() => mock.count('DELETE', `/players/${GUILD_ID}`) === 1);
    assert.equal(h.gateway.length, 1, 'no leave sent: Discord already removed the bot');
  });

  it('rejoins voice after Lavalink reports an invalid voice session (4006)', async () => {
    const { mock, h } = await setup();
    const player = await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    mock.closeVoice(GUILD_ID, 4006);
    await waitFor(() => mock.patches(GUILD_ID).some((r) => r.body.voice?.sessionId === 'voice-session-3'), 3000, 'fresh voice forwarded');
    assert.deepEqual(
      h.gateway.map((g) => g.payload.d.channel_id),
      [VOICE_ID, null, VOICE_ID],
    );
    assert.equal(player.destroyed, false);
  });

  it('moves between channels and forwards the new channel id', async () => {
    const { mock, h } = await setup();
    const player = await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    const moved = nextEvent(h.raya, 'playerMove');
    await player.moveTo(OTHER_VOICE_ID);
    assert.deepEqual((await moved).slice(1), [VOICE_ID, OTHER_VOICE_ID]);
    assert.equal(player.voiceChannelId, OTHER_VOICE_ID);
    assert.equal(mock.patches(GUILD_ID).at(-1)!.body.voice.channelId, OTHER_VOICE_ID);
  });

  it('pauses in an empty channel, resumes when someone returns, and leaves after the timeout', async () => {
    const { mock, h } = await setup({ playerDefaults: { emptyChannelTimeout: 200, pauseOnEmpty: true } });
    h.raya.handleRaw({
      t: 'GUILD_CREATE',
      d: { id: GUILD_ID, voice_states: [{ user_id: USER_ID, channel_id: VOICE_ID }], members: [{ user: { id: BOT_ID, bot: true } }] },
    });
    const player = await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    const result = await player.search('empty channel test');
    await player.play(result.tracks[0]!);
    await waitFor(() => mock.player(GUILD_ID)?.track);

    const empty = nextEvent(h.raya, 'voiceChannelEmpty');
    h.raya.handleRaw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: GUILD_ID, user_id: USER_ID, session_id: 'u', channel_id: null } });
    await empty;
    await waitFor(() => mock.player(GUILD_ID)!.paused, 2000, 'paused on Lavalink');
    assert.equal(player.paused, true);

    const filled = nextEvent(h.raya, 'voiceChannelFilled');
    h.raya.handleRaw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: GUILD_ID, user_id: USER_ID, session_id: 'u', channel_id: VOICE_ID } });
    await filled;
    await waitFor(() => !mock.player(GUILD_ID)!.paused, 2000, 'resumed on Lavalink');
    await delay(250);
    assert.equal(player.destroyed, false, 'timeout was cancelled');

    const destroyed = nextEvent(h.raya, 'playerDestroy');
    h.raya.handleRaw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: GUILD_ID, user_id: USER_ID, session_id: 'u', channel_id: null } });
    assert.equal((await destroyed)[1], 'channelEmpty');
  });

  it('never assumes a channel is empty without a GUILD_CREATE snapshot', async () => {
    const { h } = await setup({ playerDefaults: { emptyChannelTimeout: 50 } });
    let empties = 0;
    h.raya.on('voiceChannelEmpty', () => empties++);
    const player = await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    h.raya.handleRaw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: GUILD_ID, user_id: USER_ID, session_id: 'u', channel_id: null } });
    await delay(120);
    assert.equal(empties, 0);
    assert.equal(player.destroyed, false);
  });

  it('leaves after the queue ends when queueEndTimeout is set', async () => {
    const { mock, h } = await setup({ playerDefaults: { queueEndTimeout: 80 } });
    const player = await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    await player.enqueue(await player.search('short queue'));
    await waitFor(() => mock.player(GUILD_ID)?.track);
    const destroyed = nextEvent(h.raya, 'playerDestroy');
    mock.finishTrack(GUILD_ID);
    assert.equal((await destroyed)[1], 'queueEnd');
    assert.equal(h.gateway.at(-1)!.payload.d.channel_id, null, 'left the voice channel');
  });

  it('routes a new player to a node in the voice server region', async () => {
    const mocks = await Promise.all([MockLavalink.start(), MockLavalink.start()]);
    const h = createHarness(mocks, {
      nodes: [
        { name: 'us', host: '127.0.0.1', port: mocks[0]!.port, password: mocks[0]!.password, regions: ['us', 'atl'] },
        { name: 'eu', host: '127.0.0.1', port: mocks[1]!.port, password: mocks[1]!.password, regions: ['ams', 'eu'] },
      ],
    });
    cleanups.push(async () => {
      await h.raya.destroy();
      for (const mock of mocks) await mock.stop();
    });
    await h.raya.init(BOT_ID);
    const player = h.raya.createPlayer({ guildId: GUILD_ID, voiceChannelId: VOICE_ID, node: 'us' });
    await player.connect();
    assert.equal(player.node.name, 'eu', 'endpoint c-ams01 routes to the ams node');
    assert.equal(mocks[0]!.patches(GUILD_ID).length, 0);
    assert.equal(mocks[1]!.patches(GUILD_ID).length, 1);
  });

  it('rejects with VOICE_TIMEOUT when Discord never answers', async () => {
    const { h } = await setup();
    h.autoVoice.enabled = false;
    await assert.rejects(
      h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID, timeout: 80 }),
      (error: RayaError) => error.code === 'VOICE_TIMEOUT',
    );
    assert.equal(h.raya.getPlayer(GUILD_ID), undefined, 'the half-created player was cleaned up');
  });
});
