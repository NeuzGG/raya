import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockLavalink } from './helpers/MockLavalink';
import { BOT_ID, GUILD_ID, USER_ID, VOICE_ID, createHarness, delay, nextEvent, waitFor, type Harness } from './helpers/harness';
import type { Player } from '../src/player/Player';
import type { Track } from '../src/types/raya';

describe('playback', () => {
  let mock: MockLavalink;
  let h: Harness;

  beforeEach(async () => {
    mock = await MockLavalink.start();
    h = createHarness([mock]);
    await h.raya.init(BOT_ID);
  });

  afterEach(async () => {
    await h.raya.destroy();
    await mock.stop();
  });

  const join = () => h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID, textChannelId: 'text-1' });
  const playing = () => mock.player(GUILD_ID)?.track?.info.identifier;

  async function queueSongs(player: Player, count: number): Promise<Track[]> {
    const result = await player.search('song', { requester: { id: USER_ID } });
    const tracks = result.tracks.slice(0, count);
    await player.enqueue(tracks);
    await waitFor(() => playing() === tracks[0]!.info.identifier, 3000, 'first track');
    return tracks;
  }

  it('connects with v4 headers and enables session resuming', async () => {
    const upgrade = mock.upgrades[0]!;
    assert.equal(upgrade.headers['user-id'], BOT_ID);
    assert.match(String(upgrade.headers['client-name']), /^Raya\//);
    assert.equal(upgrade.headers['session-id'], undefined);
    const node = h.raya.readyNodes[0]!;
    assert.ok(node.sessionId);
    const sessionPatch = await waitFor(() => mock.requests.find((r) => r.method === 'PATCH' && r.path === `/v4/sessions/${node.sessionId}`));
    assert.deepEqual(sessionPatch.body, { resuming: true, timeout: 60 });
    await waitFor(() => node.info, 2000, 'node info');
    assert.ok(node.hasSource('youtube'));
  });

  it('joins voice and forwards credentials including channelId', async () => {
    const player = await join();
    assert.deepEqual(h.gateway[0]!.payload, {
      op: 4,
      d: { guild_id: GUILD_ID, channel_id: VOICE_ID, self_mute: false, self_deaf: true },
    });
    const voicePatch = mock.patches(GUILD_ID).find((r) => r.body.voice)!;
    assert.deepEqual(voicePatch.body.voice, {
      token: 'token-1',
      endpoint: 'c-ams01-abcdef.discord.media:443',
      sessionId: 'voice-session-1',
      channelId: VOICE_ID,
    });
    await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    assert.equal(h.gateway.length, 1, 'joining the same channel again is a no-op');
    assert.equal(h.raya.getPlayer(GUILD_ID), player);
  });

  it('normalizes, caches and de-duplicates searches without leaking requesters', async () => {
    const [first, second] = await Promise.all([
      h.raya.search('lofi beats', { requester: { id: USER_ID } }),
      h.raya.search('lofi beats'),
    ]);
    assert.equal(mock.count('GET', '/v4/loadtracks'), 1, 'concurrent identical searches share one request');
    assert.equal(first.type, 'search');
    assert.equal(first.identifier, 'ytsearch:lofi beats');
    assert.equal(first.tracks.length, 5);
    assert.deepEqual(first.tracks[0]!.requester, { id: USER_ID });
    assert.equal(second.tracks[0]!.requester, undefined);
    assert.notEqual(first.tracks[0], second.tracks[0], 'each result gets its own track objects');

    const third = await h.raya.search('lofi beats');
    assert.equal(third.cached, true);
    assert.equal(mock.count('GET', '/v4/loadtracks'), 1);

    const playlist = await h.raya.search('https://example.com/playlist');
    assert.equal(playlist.type, 'playlist');
    assert.equal(playlist.playlist!.name, 'Mock Playlist');
    assert.equal(playlist.playlist!.duration, 3 * 180000);

    const failed = await h.raya.search('https://example.com/error');
    assert.equal(failed.type, 'error');
    assert.equal(failed.exception!.message, 'Load failed');
    assert.equal((await h.raya.search('https://example.com/nothing')).type, 'empty');
  });

  it('plays the queue in order, keeps requesters and emits queueEnd', async () => {
    const player = await join();
    const started: Track[] = [];
    const ended: string[] = [];
    h.raya.on('trackStart', (_p, track) => started.push(track));
    h.raya.on('trackEnd', (_p, _t, reason) => ended.push(reason));

    const tracks = await queueSongs(player, 3);
    await waitFor(() => started.length === 1);
    assert.equal(started[0], tracks[0], 'trackStart gives back the exact queued track object');
    assert.deepEqual(started[0]!.requester, { id: USER_ID });

    mock.finishTrack(GUILD_ID);
    await waitFor(() => playing() === tracks[1]!.info.identifier);
    mock.finishTrack(GUILD_ID);
    await waitFor(() => playing() === tracks[2]!.info.identifier);

    const queueEnd = nextEvent(h.raya, 'queueEnd');
    mock.finishTrack(GUILD_ID);
    const [, last] = await queueEnd;
    assert.equal(last, tracks[2]);
    assert.equal(player.current, null);
    assert.deepEqual(player.queue.history.map((t) => t.info.identifier), tracks.map((t) => t.info.identifier));
    assert.deepEqual(ended, ['finished', 'finished', 'finished']);
  });

  it('merges updates made in the same tick into one PATCH (volume 100 = 100%)', async () => {
    const player = await join();
    await queueSongs(player, 1);
    const before = mock.patches(GUILD_ID).length;

    await Promise.all([player.setVolume(100), player.pause(), player.filters.nightcore(), player.filters.bassBoost('low')]);

    const patches = mock.patches(GUILD_ID);
    assert.equal(patches.length, before + 1, 'four calls, one request');
    const body = patches.at(-1)!.body;
    assert.equal(body.volume, 100);
    assert.equal(body.paused, true);
    assert.ok(body.filters.timescale);
    assert.ok(body.filters.equalizer.length > 0);
  });

  it('loops a track and loops the queue', async () => {
    const player = await join();
    const tracks = await queueSongs(player, 2);
    player.setLoop('track');
    const trackPatches = () => mock.patches(GUILD_ID).filter((r) => r.body.track).length;
    const before = trackPatches();

    mock.finishTrack(GUILD_ID);
    await waitFor(() => trackPatches() === before + 1 && playing() === tracks[0]!.info.identifier, 3000, 'loop replay');
    assert.equal(player.current, tracks[0]);
    assert.equal(player.queue.size, 1);

    player.setLoop('queue');
    mock.finishTrack(GUILD_ID);
    await waitFor(() => playing() === tracks[1]!.info.identifier);
    assert.deepEqual(player.queue.toArray().map((t) => t.info.identifier), [tracks[0]!.info.identifier]);
  });

  it('skips, goes back and stops', async () => {
    const player = await join();
    const [a, b, c] = await queueSongs(player, 3);

    assert.equal((await player.skip())!.info.identifier, b!.info.identifier);
    await waitFor(() => playing() === b!.info.identifier);

    assert.equal((await player.previous())!.info.identifier, a!.info.identifier);
    await waitFor(() => playing() === a!.info.identifier);
    assert.deepEqual(player.queue.toArray().map((t) => t.info.identifier), [b!.info.identifier, c!.info.identifier]);

    await player.skip(2);
    await waitFor(() => playing() === c!.info.identifier);

    const queueEnd = nextEvent(h.raya, 'queueEnd');
    assert.equal(await player.skip(), null);
    await queueEnd;
    await waitFor(() => mock.player(GUILD_ID)!.track === null, 2000, 'stopped on Lavalink');

    await player.play(a!);
    await waitFor(() => playing() === a!.info.identifier);
    await player.stop();
    assert.equal(player.current, null);
    await waitFor(() => mock.player(GUILD_ID)!.track === null);
  });

  it('stays consistent when skipping faster than Lavalink events arrive', async () => {
    const player = await join();
    await queueSongs(player, 5);
    const log: string[] = [];
    h.raya.on('trackStart', (_p, t) => log.push(`start:${t.info.identifier}`));
    h.raya.on('queueEnd', () => log.push('queueEnd'));
    for (let i = 0; i < 5; i++) await player.skip();
    await delay(150);
    assert.equal(player.current, null);
    assert.equal(mock.player(GUILD_ID)!.track, null);
    assert.equal(log.at(-1), 'queueEnd', `no stale trackStart after the queue ended: ${log.join(' ')}`);
    assert.equal(player.queue.history.length, 5);
  });

  it('advances past tracks that fail to load and reports the error', async () => {
    const player = await join();
    const [a, b] = await queueSongs(player, 2);
    const error = nextEvent(h.raya, 'trackError');
    mock.failTrack(GUILD_ID);
    const [, failed, exception] = await error;
    assert.equal(failed, a);
    assert.equal(exception.message, 'boom');
    await waitFor(() => playing() === b!.info.identifier);
    assert.equal(player.queue.history.length, 0, 'failed tracks are not added to history');
  });

  it('skips stuck tracks', async () => {
    const player = await join();
    const [, b] = await queueSongs(player, 2);
    mock.stuckTrack(GUILD_ID);
    await waitFor(() => playing() === b!.info.identifier);
  });

  it('autoplays a related track that was not played yet', async () => {
    const player = await join();
    player.setAutoplay(true);
    const [a] = await queueSongs(player, 1);
    mock.finishTrack(GUILD_ID);
    await waitFor(() => playing() === `${a!.info.identifier}-rel-1`, 3000, 'autoplay track');
    assert.ok(mock.requests.some((r) => r.query.get('identifier')?.includes(`list=RD${a!.info.identifier}`)));
    assert.deepEqual(player.current!.requester, { id: USER_ID });
  });

  it('autoplays Spotify tracks without Extended quota by searching the same source', async () => {
    mock.sourceManagers = ['spotify', 'youtube'];
    const node = h.raya.nodes.get('node1')!;
    node.info = await node.rest.info();
    const player = await join();
    player.setAutoplay(true);
    const result = await player.search('spotify song', { source: 'spotify', requester: { id: USER_ID } });
    const seed = result.tracks[0]!;
    await player.enqueue(seed);
    await waitFor(() => playing() === seed.info.identifier);

    mock.finishTrack(GUILD_ID);
    await waitFor(() => playing() !== undefined && playing() !== seed.info.identifier, 3000, 'autoplay track');
    const identifiers = mock.requests.map((r) => r.query.get('identifier'));
    assert.ok(identifiers.includes(`sprec:mix:track:${seed.info.identifier}`), 'tried Spotify radio first');
    assert.equal(player.current!.info.sourceName, 'spotify');
    assert.notEqual(player.current!.info.title, seed.info.title);
    assert.deepEqual(player.current!.requester, { id: USER_ID });
  });

  it('uses Spotify recommendations when the node supports them', async () => {
    mock.sourceManagers = ['spotify'];
    mock.spotifyRecommendations = true;
    const node = h.raya.nodes.get('node1')!;
    node.info = await node.rest.info();
    const player = await join();
    player.setAutoplay(true);
    const [seed] = (await player.search('radio seed', { source: 'spsearch' })).tracks;
    await player.enqueue(seed!);
    await waitFor(() => playing() === seed!.info.identifier);
    mock.finishTrack(GUILD_ID);
    await waitFor(() => playing()?.startsWith('rec-'), 3000, 'recommended track');
  });

  it('interpolates position, freezes it while paused and syncs from playerUpdate', async () => {
    const player = await join();
    const result = await player.search('song');
    await player.play(result.tracks[0]!, { startTime: 30000 });
    assert.ok(player.position >= 30000 && player.position < 30100);
    await delay(120);
    assert.ok(player.position >= 30100, `position advanced: ${player.position}`);

    await player.pause();
    const frozen = player.position;
    await delay(60);
    assert.equal(player.position, frozen);

    await player.resume();
    mock.sendPlayerUpdate(GUILD_ID, 90000);
    await waitFor(() => player.position >= 90000 && player.position < 91000);
    assert.equal(player.connected, true);
    assert.equal(player.ping, 12);

    await player.seek(10 ** 9);
    assert.equal(player.position, result.tracks[0]!.info.length, 'seek clamps to the track length');
  });

  it('forwards plugin events (LavaLyrics, SponsorBlock)', async () => {
    await join();
    const lyrics = nextEvent(h.raya, 'lyricsLine');
    const plugin = nextEvent(h.raya, 'pluginEvent');
    mock.sendEvent(GUILD_ID, { type: 'LyricsLineEvent', lineIndex: 3, line: { timestamp: 1000, duration: 500, line: 'la la', plugin: {} }, skipped: false });
    const [, line, index, skipped] = await lyrics;
    assert.equal(line.line, 'la la');
    assert.equal(index, 3);
    assert.equal(skipped, false);
    assert.equal((await plugin)[1].type, 'LyricsLineEvent');
  });

  it('destroys remotely before a replacement player for the same guild sends anything', async () => {
    const player = await join();
    await queueSongs(player, 1);
    const destroyed = player.destroy();
    const replacement = h.raya.createPlayer({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    assert.notEqual(replacement, player);
    await Promise.all([destroyed, replacement.connect()]);

    const deleteIndex = mock.requests.findIndex((r) => r.method === 'DELETE' && r.path.endsWith(GUILD_ID));
    const replacementVoice = mock.requests.map((r) => r.method === 'PATCH' && Boolean(r.body?.voice)).lastIndexOf(true);
    assert.ok(deleteIndex >= 0 && deleteIndex < replacementVoice, 'DELETE lands before the new player PATCH');
    assert.equal(replacement.destroyed, false, 'the old leave event did not kill the new player');
    assert.equal(h.raya.getPlayer(GUILD_ID), replacement);
  });

  it('destroys players whose channel or guild is deleted', async () => {
    const player = await join();
    const destroyed = nextEvent(h.raya, 'playerDestroy');
    h.raya.handleRaw({ t: 'CHANNEL_DELETE', d: { id: VOICE_ID, guild_id: GUILD_ID } });
    const [p, reason] = await destroyed;
    assert.equal(p, player);
    assert.equal(reason, 'channelDeleted');
    assert.equal(h.raya.getPlayer(GUILD_ID), undefined);
  });
});
