import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MockLavalink } from './helpers/MockLavalink';
import { BOT_ID, GUILD_ID, USER_ID, VOICE_ID, createHarness, waitFor, type Harness } from './helpers/harness';
import { NowPlayingFeed, type LiveSnapshot, type NowPlayingFeedOptions } from '../src/plugins/NowPlayingFeed';

const PRIVATE_GUILD = '200000000000000099';

async function openStream(url: string) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  const snapshots: LiveSnapshot[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = chunk.split('\n').find((line) => line.startsWith('data: '));
          if (chunk.includes('event: snapshot') && data) snapshots.push(JSON.parse(data.slice(6)));
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { response, snapshots, close: () => controller.abort() };
}

describe('NowPlayingFeed', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
    cleanups.length = 0;
  });

  async function setup(options: Partial<NowPlayingFeedOptions> = {}) {
    const mock = await MockLavalink.start();
    const h: Harness = createHarness([mock]);
    await h.raya.init(BOT_ID);
    const feed = new NowPlayingFeed({
      port: 0,
      host: '127.0.0.1',
      interval: 100,
      cors: 'https://neuzgg.github.io',
      publish: (guildId) => (guildId === GUILD_ID ? { name: 'Lofi Lounge', icon: 'https://cdn.example.com/icon.png' } : null),
      ...options,
    });
    await h.raya.use(feed);
    cleanups.push(async () => {
      await h.raya.destroy();
      await mock.stop();
    });
    return { mock, h, feed };
  }

  async function playIn(h: Harness, guildId: string, query: string) {
    const player = await h.raya.join({ guildId, voiceChannelId: VOICE_ID });
    const result = await player.search(query, { requester: { id: USER_ID, username: 'secret-user' } });
    await player.play(result.tracks[0]!);
    return player;
  }

  it('publishes opted-in servers only and never includes requesters', async () => {
    const { h, feed } = await setup();
    await playIn(h, GUILD_ID, 'public song');
    await playIn(h, PRIVATE_GUILD, 'private song');

    const response = await fetch(feed.url!);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://neuzgg.github.io');
    const text = await response.text();
    const snapshot = JSON.parse(text) as LiveSnapshot;

    assert.equal(snapshot.players.length, 1);
    const [entry] = snapshot.players;
    assert.equal(entry!.server.name, 'Lofi Lounge');
    assert.equal(entry!.server.icon, 'https://cdn.example.com/icon.png');
    assert.equal(entry!.track.title, 'public song 1');
    assert.equal(entry!.paused, false);
    assert.deepEqual(snapshot.totals, { playing: 2 }, 'totals count every server, as a number only');
    assert.ok(!text.includes('private song'), 'private servers stay private');
    assert.ok(!text.includes('secret-user') && !text.includes(USER_ID), 'requesters are never shared');
  });

  it('streams live updates for track changes, pauses, seeks and stops', async () => {
    const { h, feed } = await setup();
    const stream = await openStream(`${feed.url}/stream`);
    cleanups.push(stream.close);
    assert.equal(stream.response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    await waitFor(() => stream.snapshots.length >= 1, 2000, 'initial snapshot');
    assert.equal(stream.snapshots[0]!.players.length, 0);

    const player = await playIn(h, GUILD_ID, 'live song');
    await waitFor(() => stream.snapshots.at(-1)?.players[0]?.track.title === 'live song 1', 2000, 'track appears');

    await player.pause();
    await waitFor(() => stream.snapshots.at(-1)?.players[0]?.paused === true, 2000, 'pause is pushed');

    await player.seek(120_000);
    await waitFor(() => (stream.snapshots.at(-1)?.players[0]?.position ?? 0) >= 120_000, 2000, 'seek is pushed');

    const count = stream.snapshots.length;
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(stream.snapshots.length, count, 'no updates when nothing changed');

    await player.stop();
    await waitFor(() => stream.snapshots.at(-1)?.players.length === 0, 2000, 'stopped player disappears');
    assert.equal(feed.connections, 1);
  });

  it('mounts on an existing HTTP server and leaves other routes alone', async () => {
    const { h } = await setup({ port: undefined });
    const feed = [...(h.raya as unknown as { plugins: Map<string, NowPlayingFeed> }).plugins.values()].find((p) => p instanceof NowPlayingFeed)!;
    assert.equal(feed.url, null);

    const server = http.createServer((req, res) => {
      if (!feed.handle(req, res)) res.writeHead(418).end('mine');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    assert.equal((await fetch(`${base}/now-playing`)).status, 200);
    assert.equal((await fetch(`${base}/now-playing/`)).status, 200);
    assert.equal((await fetch(`${base}/somewhere-else`)).status, 418);
    assert.equal((await fetch(`${base}/now-playing`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/now-playing`, { method: 'OPTIONS' })).status, 204);
  });

  it('limits stream connections', async () => {
    const { feed } = await setup({ maxClients: 1 });
    const first = await openStream(`${feed.url}/stream`);
    cleanups.push(first.close);
    await waitFor(() => feed.connections === 1);
    const second = await fetch(`${feed.url}/stream`);
    assert.equal(second.status, 503);
  });

  it('drops unsafe URLs and clips long text from publish()', async () => {
    const { h, feed } = await setup({
      publish: () => ({ name: 'x'.repeat(500), icon: 'javascript:alert(1)' }),
    });
    await playIn(h, GUILD_ID, 'safe song');
    const snapshot = (await (await fetch(feed.url!)).json()) as LiveSnapshot;
    assert.equal(snapshot.players[0]!.server.icon, null);
    assert.equal(snapshot.players[0]!.server.name.length, 200);
  });

  it('requires bot and/or publish', () => {
    assert.throws(() => new NowPlayingFeed({} as NowPlayingFeedOptions), TypeError);
    assert.throws(() => new NowPlayingFeed({ publish: 'nope' } as unknown as NowPlayingFeedOptions), TypeError);
    assert.doesNotThrow(() => new NowPlayingFeed({ bot: { name: 'Raya' } }));
  });

  describe('bot mode', () => {
    const bot = { name: 'Raya', avatar: 'https://cdn.discordapp.com/avatars/1/abc.png', url: 'https://discord.com/oauth2/authorize?client_id=1' };

    it("shares the bot and its current song without any server information", async () => {
      const { h, feed } = await setup({ publish: undefined, bot });
      await playIn(h, GUILD_ID, 'bot song');

      const text = await (await fetch(feed.url!)).text();
      const snapshot = JSON.parse(text) as LiveSnapshot;
      assert.deepEqual({ ...snapshot.bot, uptime: undefined }, { ...bot, uptime: undefined });
      assert.ok(snapshot.bot!.uptime > 0);
      assert.equal(snapshot.nowPlaying!.track.title, 'bot song 1');
      assert.equal(snapshot.nowPlaying!.paused, false);
      assert.deepEqual(snapshot.players, [], 'no server cards without publish');
      assert.ok(!text.includes(GUILD_ID) && !text.includes('Lofi Lounge'), 'no server id or name');
      assert.ok(!text.includes('secret-user') && !text.includes(USER_ID), 'no requesters');
    });

    it('keeps showing the same song while it plays instead of jumping between servers', async () => {
      const { h, feed } = await setup({ publish: undefined, bot });
      const title = async () => ((await (await fetch(feed.url!)).json()) as LiveSnapshot).nowPlaying?.track.title;
      const first = await playIn(h, GUILD_ID, 'first server song');
      assert.equal(await title(), 'first server song 1', 'the only song is shown');

      await playIn(h, PRIVATE_GUILD, 'second server song');
      await new Promise((resolve) => setTimeout(resolve, 250)); // let the second trackStart arrive
      assert.equal(await title(), 'first server song 1', 'sticky while playing');
      await first.pause();
      assert.equal(await title(), 'second server song 1', 'switches when the shown song pauses');
      await h.raya.getPlayer(PRIVATE_GUILD)!.stop();
      assert.equal(await title(), 'first server song 1', 'falls back to a paused song');
      await first.stop();
      assert.equal(await title(), undefined, 'nothing playing');
    });

    it('lets you leave servers out of the shared song', async () => {
      const { h, feed } = await setup({ publish: undefined, bot: () => bot, nowPlaying: (guildId) => guildId !== PRIVATE_GUILD });
      await playIn(h, PRIVATE_GUILD, 'excluded song');
      let snapshot = (await (await fetch(feed.url!)).json()) as LiveSnapshot;
      assert.equal(snapshot.nowPlaying, null);
      assert.equal(snapshot.bot!.name, 'Raya');
      await playIn(h, GUILD_ID, 'included song');
      snapshot = (await (await fetch(feed.url!)).json()) as LiveSnapshot;
      assert.equal(snapshot.nowPlaying!.track.title, 'included song 1');
    });

    it('streams song changes and pauses', async () => {
      const { h, feed } = await setup({ publish: undefined, bot });
      const stream = await openStream(`${feed.url}/stream`);
      cleanups.push(stream.close);
      await waitFor(() => stream.snapshots.length >= 1);
      assert.equal(stream.snapshots[0]!.nowPlaying, null);
      assert.equal(stream.snapshots[0]!.bot!.name, 'Raya');

      const player = await playIn(h, GUILD_ID, 'stream song');
      await waitFor(() => stream.snapshots.at(-1)?.nowPlaying?.track.title === 'stream song 1', 2000, 'song appears');
      await player.pause();
      await waitFor(() => stream.snapshots.at(-1)?.nowPlaying?.paused === true, 2000, 'pause pushed');
      await player.skip();
      await waitFor(() => stream.snapshots.at(-1)?.nowPlaying === null, 2000, 'cleared when the queue ends');
    });
  });
});
