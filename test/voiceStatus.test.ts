import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Raya } from '../src/Raya';
import { VoiceStatus } from '../src/plugins/VoiceStatus';
import { MockLavalink, makeTrack } from './helpers/MockLavalink';
import { BOT_ID, GUILD_ID, OTHER_VOICE_ID, VOICE_ID, createHarness, delay, waitFor } from './helpers/harness';
import type { RayaError } from '../src/utils/errors';
import type { Player } from '../src/player/Player';

interface StatusRequest {
  channelId: string;
  status: string;
  headers: http.IncomingHttpHeaders;
  at: number;
}

class FakeDiscordApi {
  public readonly requests: StatusRequest[] = [];
  public readonly responses: Array<{ status: number; body?: unknown }> = [];
  public delay = 0;
  private server!: http.Server;
  public url = '';

  public static async start(): Promise<FakeDiscordApi> {
    const api = new FakeDiscordApi();
    api.server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const match = /^\/channels\/(\d+|[\w-]+)\/voice-status$/.exec(req.url ?? '');
      if (req.method !== 'PUT' || !match) return void res.writeHead(404).end();
      api.requests.push({
        channelId: match[1]!,
        status: JSON.parse(Buffer.concat(chunks).toString()).status,
        headers: req.headers,
        at: performance.now(),
      });
      if (api.delay) await delay(api.delay);
      const next = api.responses.shift() ?? { status: 204 };
      if (next.body === undefined) return void res.writeHead(next.status).end();
      res.writeHead(next.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(next.body));
    });
    await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve));
    api.url = `http://127.0.0.1:${(api.server.address() as { port: number }).port}`;
    return api;
  }

  public statuses(channelId: string): string[] {
    return this.requests.filter((r) => r.channelId === channelId).map((r) => r.status);
  }

  public async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe('voice channel status', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
    cleanups.length = 0;
  });

  async function setup(voiceStatus: Record<string, unknown> = {}) {
    const [mock, api] = await Promise.all([MockLavalink.start(), FakeDiscordApi.start()]);
    const h = createHarness([mock], { voiceStatus: { token: 'test-token', apiBase: api.url, ...voiceStatus } });
    cleanups.push(async () => {
      await h.raya.destroy();
      await mock.stop();
      await api.stop();
    });
    await h.raya.init(BOT_ID);
    return { mock, api, h };
  }

  function standalone(api: FakeDiscordApi, options: Record<string, unknown> = {}) {
    return new Raya({ nodes: [], send: () => undefined, voiceStatus: { token: 'test-token', apiBase: api.url, ...options } });
  }

  it('shows the playing track as the channel status and clears it when the queue ends', async () => {
    const { mock, api, h } = await setup({ template: '🎶 {title} - {author} [{duration}] by {requester}' });
    const player = await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    const result = await player.search('status song', { requester: { id: '1', username: 'neuz' } });
    await player.enqueue(result);

    const expected = '🎶 status song 1 - Artist of status song [3:00] by neuz';
    await waitFor(() => api.statuses(VOICE_ID).at(-1) === expected, 3000, 'status set');
    const request = api.requests.at(-1)!;
    assert.equal(request.headers.authorization, 'Bot test-token');
    assert.match(String(request.headers['user-agent']), /^DiscordBot \(/);

    mock.finishTrack(GUILD_ID);
    await waitFor(() => api.statuses(VOICE_ID).at(-1) === '', 3000, 'status cleared');
  });

  it('clears the status on stop and follows the bot to another channel', async () => {
    const { api, h } = await setup();
    const player = await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    await player.enqueue(await player.search('moving song'));
    await waitFor(() => api.statuses(VOICE_ID).at(-1) === 'Now playing: moving song 1');

    await player.moveTo(OTHER_VOICE_ID);
    await waitFor(() => api.statuses(VOICE_ID).at(-1) === '', 3000, 'old channel cleared');
    await waitFor(() => api.statuses(OTHER_VOICE_ID).at(-1) === 'Now playing: moving song 1', 3000, 'new channel set');

    await player.stop();
    await waitFor(() => api.statuses(OTHER_VOICE_ID).at(-1) === '', 3000, 'cleared on stop');
  });

  it('clears the status before the bot leaves when the player is destroyed', async () => {
    const { api, h } = await setup();
    const player = await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    await player.enqueue(await player.search('goodbye song'));
    await waitFor(() => api.statuses(VOICE_ID).at(-1) === 'Now playing: goodbye song 1');

    await player.destroy();
    const clear = api.requests.filter((r) => r.channelId === VOICE_ID && r.status === '').at(-1);
    const leave = h.gateway.filter((g) => g.payload.d.channel_id === null).at(-1);
    assert.ok(clear, 'status was cleared');
    assert.ok(leave, 'bot left voice');
    assert.ok(clear.at < leave.at, 'Discord received the clear while the bot was still in the channel');
  });

  it('a new player created right after destroy waits for the old one to leave first', async () => {
    const { api, h } = await setup();
    const player = await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    await player.enqueue(await player.search('stop then play'));
    await waitFor(() => api.statuses(VOICE_ID).length === 1);
    api.delay = 50;

    const destroyed = player.destroy();
    const replacement = await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    await destroyed;
    await delay(50);

    assert.deepEqual(
      h.gateway.map((g) => g.payload.d.channel_id),
      [VOICE_ID, null, VOICE_ID],
      'join, leave, join in that order',
    );
    assert.equal(replacement.destroyed, false);
    assert.equal(h.raya.getPlayer(GUILD_ID), replacement);
    api.delay = 0;
  });

  it('never holds up leaving when the Discord API is slow', async () => {
    const { api, h } = await setup();
    const player = await h.raya.join({ guildId: GUILD_ID, voiceChannelId: VOICE_ID });
    await player.enqueue(await player.search('slow api song'));
    await waitFor(() => api.statuses(VOICE_ID).length === 1);
    api.delay = 5000;
    const started = performance.now();
    await player.destroy();
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2500, `destroy took ${Math.round(elapsed)}ms`);
    api.delay = 0;
  });

  it('sends only the latest status when updates overlap', async () => {
    const api = await FakeDiscordApi.start();
    cleanups.push(() => api.stop());
    const raya = standalone(api);
    api.delay = 40;
    void raya.voiceStatus!.set('111', 'first');
    void raya.voiceStatus!.set('111', 'second');
    await raya.voiceStatus!.set('111', 'third');
    assert.deepEqual(api.statuses('111'), ['first', 'third']);
    await raya.voiceStatus!.set('111', 'third');
    assert.equal(api.statuses('111').length, 2, 'unchanged text is not re-sent');
  });

  it('retries rate limits and reports permission errors', async () => {
    const api = await FakeDiscordApi.start();
    cleanups.push(() => api.stop());
    const errors: Array<[string, string]> = [];
    const raya = standalone(api, { onError: (error: Error, channelId: string) => errors.push([channelId, error.message]) });

    api.responses.push({ status: 429, body: { message: 'You are being rate limited.', retry_after: 0.02 } });
    await raya.voiceStatus!.set('222', 'after rate limit');
    assert.deepEqual(api.statuses('222'), ['after rate limit', 'after rate limit']);
    assert.equal(errors.length, 0);

    api.responses.push({ status: 403, body: { message: 'Missing Permissions', code: 50013 } });
    await assert.rejects(raya.voiceStatus!.set('333', 'nope'), (error: RayaError) => error.code === 'DISCORD_API_ERROR');
    assert.equal(errors[0]![0], '333');
    assert.match(errors[0]![1], /Missing Permissions/);
  });

  it('takes the token from the connector, truncates to 500 characters and formats templates', async () => {
    const api = await FakeDiscordApi.start();
    cleanups.push(() => api.stop());
    const raya = new Raya({
      nodes: [],
      connector: { attach: () => undefined, send: () => undefined, getToken: () => 'Bot from-connector' },
      voiceStatus: { apiBase: api.url },
    });
    await raya.voiceStatus!.set('444', 'x'.repeat(600));
    const request = api.requests.at(-1)!;
    assert.equal(request.headers.authorization, 'Bot from-connector');
    assert.equal(request.status.length, 500);
    assert.ok(request.status.endsWith('…'));

    const formatter = new VoiceStatus({ template: '{title} [{duration}] {unknown}' });
    const player = {} as Player;
    assert.equal(formatter.format(makeTrack('Radio', { isStream: true }), player), 'Radio [LIVE] {unknown}');
    assert.equal(formatter.format(makeTrack('Long', { length: 3_723_000 }), player), 'Long [1:02:03] {unknown}');
    const fn = new VoiceStatus({ template: (track) => `▶ ${track.info.title.toUpperCase()}` });
    assert.equal(fn.format(makeTrack('quiet'), player), '▶ QUIET');
  });
});

describe('debug option and default search source', () => {
  it('logs through a custom logger and searches with spsearch by default', async () => {
    const mock = await MockLavalink.start();
    const logs: string[] = [];
    const h = createHarness([mock], { debug: (message) => logs.push(message), defaultSearchSource: 'spsearch' });
    try {
      await h.raya.init(BOT_ID);
      const result = await h.raya.search('daft punk');
      assert.equal(result.identifier, 'spsearch:daft punk');
      assert.equal(mock.requests.find((r) => r.path === '/v4/loadtracks')!.query.get('identifier'), 'spsearch:daft punk');
      assert.ok(logs.some((l) => /\[Node node1\] ready/.test(l)), 'node lifecycle is logged');
      assert.ok(logs.some((l) => l.includes('Search "spsearch:daft punk" -> search (5 tracks)')), 'searches are logged');
      assert.equal((await h.raya.search('daft punk', { source: 'soundcloud' })).identifier, 'scsearch:daft punk');
    } finally {
      await h.raya.destroy();
      await mock.stop();
    }
  });

  it('debug: true prints to the console', async () => {
    const printed: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void printed.push(args.join(' '));
    try {
      const raya = new Raya({ nodes: [], send: () => undefined, debug: true });
      raya.emit('debug', 'hello');
    } finally {
      console.log = original;
    }
    assert.ok(printed.some((line) => line.startsWith('[Raya] Raya ')));
    assert.ok(printed.includes('[Raya] hello'));
  });
});
