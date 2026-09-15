import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockLavalink } from './helpers/MockLavalink';
import { BOT_ID, GUILD_ID, USER_ID, VOICE_ID, createHarness, delay, nextEvent, waitFor, type Harness } from './helpers/harness';
import type { RayaError } from '../src/utils/errors';
import type { RayaSnapshot } from '../src/types/raya';

describe('resilience', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
    cleanups.length = 0;
  });

  async function setup(mockOptions: Parameters<typeof MockLavalink.start>[0] = {}, count = 1, harnessOptions = {}) {
    const mocks = await Promise.all(Array.from({ length: count }, () => MockLavalink.start(mockOptions)));
    const h = createHarness(mocks, harnessOptions);
    cleanups.push(async () => {
      await h.raya.destroy();
      for (const mock of mocks) await mock.stop().catch(() => undefined);
    });
    return { mocks, h };
  }

  async function playSomething(h: Harness, mock: MockLavalink, node?: string) {
    const player = await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID, node });
    const result = await player.search('resilient song', { requester: { id: USER_ID } });
    await player.enqueue(result.tracks.slice(0, 3));
    await waitFor(() => mock.player(GUILD_ID)?.track, 3000, 'track on mock');
    return { player, tracks: result.tracks.slice(0, 3) };
  }

  it('resumes the Lavalink session after a connection drop without replaying anything', async () => {
    const { mocks: [mock], h } = await setup();
    await h.raya.init(BOT_ID);
    const { player } = await playSomething(h, mock!);
    const node = player.node;
    const sessionId = node.sessionId;
    const current = player.current;
    const patchesBefore = mock!.patches(GUILD_ID).length;

    const ready = nextEvent(h.raya, 'nodeReady');
    const resumedPlayer = nextEvent(h.raya, 'playerResume');
    mock!.dropConnections();
    const [, resumed] = await ready;
    await resumedPlayer;

    assert.equal(resumed, true);
    assert.equal(mock!.upgrades.at(-1)!.headers['session-id'], sessionId);
    assert.equal(node.sessionId, sessionId);
    assert.equal(player.current, current, 'same track object, requester intact');
    assert.equal(mock!.patches(GUILD_ID).length, patchesBefore, 'no rebuild requests were needed');
  });

  it('rebuilds players with track, position, volume and voice when the session is lost', async () => {
    const { mocks: [mock], h } = await setup();
    await h.raya.init(BOT_ID);
    const { player, tracks } = await playSomething(h, mock!);
    await player.seek(60000);
    await player.setVolume(55);

    const ready = nextEvent(h.raya, 'nodeReady');
    await mock!.restartFresh();
    const [, resumed] = await ready;
    assert.equal(resumed, false);

    const rebuilt = await waitFor(() => mock!.player(GUILD_ID)?.track && mock!.player(GUILD_ID), 3000, 'rebuilt player');
    assert.equal(rebuilt.track!.info.identifier, tracks[0]!.info.identifier);
    assert.ok(rebuilt.position >= 60000 && rebuilt.position < 61500, `position kept (${rebuilt.position})`);
    assert.equal(rebuilt.volume, 55);
    assert.equal(rebuilt.voice.token, 'token-1');
    assert.equal(player.queue.size, 2, 'queue untouched');
  });

  it('fails players over to another node when their node dies', async () => {
    const { mocks: [dead, alive], h } = await setup({}, 2, { failover: { delay: 100 } });
    await h.raya.init(BOT_ID);
    const { player, tracks } = await playSomething(h, dead!, 'node1');
    await player.filters.nightcore();
    await player.seek(42000);

    const moved = nextEvent(h.raya, 'playerNodeMove', 5000);
    await dead!.stop();
    const [, from, to] = await moved;
    assert.equal(from.name, 'node1');
    assert.equal(to.name, 'node2');
    assert.equal(player.node.name, 'node2');

    const remote = await waitFor(() => alive!.player(GUILD_ID)?.track && alive!.player(GUILD_ID), 3000, 'player on node2');
    assert.equal(remote.track!.info.identifier, tracks[0]!.info.identifier);
    assert.ok(remote.position >= 42000 && remote.position < 43500);
    assert.ok(remote.filters.timescale, 'filters moved too');
    assert.equal(remote.voice.sessionId, 'voice-session-1', 'voice credentials reused');

    alive!.finishTrack(GUILD_ID);
    await waitFor(() => alive!.player(GUILD_ID)?.track?.info.identifier === tracks[1]!.info.identifier, 3000, 'queue continues on node2');
  });

  it('restores players after a bot restart from a snapshot (zero audio interruption)', async () => {
    const mock = await MockLavalink.start();
    const first = createHarness([mock]);
    await first.raya.init(BOT_ID);
    const { player, tracks } = await playSomething(first, mock);
    await player.setVolume(70);
    player.setLoop('queue');
    player.data.set('dj', USER_ID);

    const snapshot: RayaSnapshot = JSON.parse(JSON.stringify(await first.raya.shutdown()));
    assert.equal(snapshot.players.length, 1);
    await delay(50);
    assert.ok(mock.player(GUILD_ID)?.track, 'Lavalink keeps playing while the bot is down');

    const second = createHarness([mock], { restore: snapshot });
    cleanups.push(async () => {
      await second.raya.destroy();
      await mock.stop();
    });
    const resumedPlayer = nextEvent(second.raya, 'playerResume');
    await second.raya.init(BOT_ID);
    await resumedPlayer;

    assert.equal(mock.upgrades.at(-1)!.headers['session-id'], snapshot.sessions.node1);
    assert.equal(mock.upgrades.at(-1)!.resumed, true);
    const restored = second.raya.getPlayer(GUILD_ID)!;
    assert.equal(restored.current!.info.identifier, tracks[0]!.info.identifier);
    assert.deepEqual(restored.current!.requester, { id: USER_ID });
    assert.equal(restored.queue.size, 2);
    assert.equal(restored.volume, 70);
    assert.equal(restored.loop, 'queue');
    assert.equal(restored.data.get('dj'), USER_ID);
    assert.equal(mock.count('DELETE', `/players/${GUILD_ID}`), 0);

    mock.finishTrack(GUILD_ID);
    await waitFor(() => mock.player(GUILD_ID)?.track?.info.identifier === tracks[1]!.info.identifier, 3000, 'restored player keeps control');
    await waitFor(() => restored.queue.at(-1)?.info.identifier === tracks[0]!.info.identifier);
  });

  it('cleans up remote players nobody controls after resuming', async () => {
    const mock = await MockLavalink.start();
    const first = createHarness([mock]);
    await first.raya.init(BOT_ID);
    await playSomething(first, mock);
    const snapshot = await first.raya.shutdown();

    const second = createHarness([mock], {
      nodes: [{ name: 'node1', host: '127.0.0.1', port: mock.port, password: mock.password, sessionId: snapshot.sessions.node1 }],
    });
    cleanups.push(async () => {
      await second.raya.destroy();
      await mock.stop();
    });
    await second.raya.init(BOT_ID);
    await waitFor(() => mock.count('DELETE', `/players/${GUILD_ID}`) === 1, 3000, 'orphan destroyed');
  });

  it('does not hammer a node that rejects the password', async () => {
    const mock = await MockLavalink.start({ password: 'correct' });
    const h = createHarness([], {
      nodes: [{ name: 'bad', host: '127.0.0.1', port: mock.port, password: 'wrong', retry: { baseDelay: 10 } }],
    });
    cleanups.push(async () => {
      await h.raya.destroy();
      await mock.stop();
    });
    const errors: RayaError[] = [];
    let reconnects = 0;
    h.raya.on('nodeError', (_n, e) => errors.push(e as RayaError));
    h.raya.on('nodeReconnecting', () => reconnects++);
    await h.raya.init(BOT_ID);
    await delay(150);
    assert.equal(h.raya.readyNodes.length, 0);
    assert.equal(reconnects, 0);
    assert.equal(mock.upgrades.length, 0);
    assert.ok(errors.some((e) => e.code === 'NODE_AUTH_FAILED'));
  });

  it('detects dead connections with WebSocket pings and reconnects', async () => {
    const mock = await MockLavalink.start({ autoPong: false });
    const h = createHarness([], {
      nodes: [{ name: 'node1', host: '127.0.0.1', port: mock.port, password: mock.password, pingInterval: 60, retry: { baseDelay: 20, maxDelay: 40 } }],
    });
    cleanups.push(async () => {
      await h.raya.destroy();
      await mock.stop();
    });
    await h.raya.init(BOT_ID);
    const [, info] = await nextEvent(h.raya, 'nodeDisconnect', 2000);
    assert.equal(info.wasReady, true);
    const [, resumed] = await nextEvent(h.raya, 'nodeReady', 2000);
    assert.equal(resumed, true, 'the session survives the dead socket');
  });

  it('keeps idle nodes connected (no false heartbeat timeouts without players)', async () => {
    const mock = await MockLavalink.start();
    const h = createHarness([], {
      nodes: [{ name: 'node1', host: '127.0.0.1', port: mock.port, password: mock.password, pingInterval: 40 }],
    });
    cleanups.push(async () => {
      await h.raya.destroy();
      await mock.stop();
    });
    let disconnects = 0;
    h.raya.on('nodeDisconnect', () => disconnects++);
    await h.raya.init(BOT_ID);
    await delay(400);
    assert.equal(disconnects, 0);
    assert.ok(h.raya.nodes.get('node1')!.ping >= 0, 'latency measured');
  });

  it('retries a search on another node when the chosen node is unreachable', async () => {
    const { mocks: [down, up], h } = await setup({}, 2);
    await h.raya.init(BOT_ID);
    await down!.stop();
    const result = await h.raya.search('fallback please', { node: 'node1' });
    assert.equal(result.type, 'search');
    assert.equal(up!.count('GET', '/v4/loadtracks'), 1);
  });

  it('spreads a burst of new players across nodes before stats update', async () => {
    const { h } = await setup({}, 2);
    await h.raya.init(BOT_ID);
    h.autoVoice.enabled = false;
    const players = Array.from({ length: 10 }, (_, i) =>
      h.raya.createPlayer({ guildId: String(900000000000000000n + BigInt(i)), voiceChannelId: VOICE_ID }),
    );
    const onNode1 = players.filter((p) => p.node.name === 'node1').length;
    assert.equal(onNode1, 5);
  });
});
