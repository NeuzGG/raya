import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ButtonStyle } from 'discord.js';
import { commandBodies, commands } from '../src/commands/index.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { setFilter } from '../src/music/filters.js';
import { notice } from '../src/ui/components.js';
import { clean, duration, humanDuration, parseTime, truncate } from '../src/ui/format.js';
import { renderHelp, renderLyrics } from '../src/ui/info.js';
import { command, setCommandIds } from '../src/ui/mentions.js';
import { renderGoodbye, renderPanel, renderQueueEnd, renderTrackProblem } from '../src/ui/panel.js';
import { renderClearConfirm, renderQueue } from '../src/ui/queue.js';
import { renderSound } from '../src/ui/sound.js';
import { assertCard, buttonById, buttons, player, text, texts, track } from './helpers/cards.js';

const many = (count) => Array.from({ length: count }, (_, i) => track(`Queued song ${i + 1}`));

describe('cards follow the design rules', () => {
  const cases = {
    'playing panel': () => renderPanel(player({ current: track('Playing'), queue: many(3), history: [track('Old')] })),
    'paused panel with lyrics': () => renderPanel(player({ current: track('Paused'), paused: true, lyrics: true })),
    'live stream panel': () => renderPanel(player({ current: track('Radio', { isStream: true, isSeekable: false }) })),
    'repeating panel': () => renderPanel(player({ current: track('Again'), loop: 'track' })),
    'queue ended': () => renderQueueEnd(player({ history: [track('Last')] }), track('Last'), { queueEndLeaveDelay: 60_000 }),
    goodbye: () => renderGoodbye(player(), 'channelEmpty'),
    'empty queue': () => renderQueue(player({ current: track('Now') })),
    'full queue page': () => renderQueue(player({ current: track('Now'), queue: many(35) }), 2),
    'clear confirm': () => renderClearConfirm(player({ queue: many(4) }), 0),
    'sound board': () => renderSound(player({ current: track('Now') })),
    lyrics: () => renderLyrics(track('Song'), { provider: 'Genius', sourceName: 'genius', text: 'la '.repeat(5000), lines: [], plugin: {} }),
    help: () => renderHelp({ servers: 3, playing: 1, ping: 42, version: '1.0.0', links: { website: 'https://neuzgg.github.io/raya/', github: 'https://github.com/neuzgg/raya', invite: 'https://discord.com/oauth2/authorize?client_id=1', support: null } }),
    'track problem': () => renderTrackProblem(track('Broken'), 'This video is unavailable'),
    notice: () => notice('Added a song', { note: 'plays next' }),
  };
  for (const [name, render] of Object.entries(cases)) {
    it(name, () => assertCard(render()));
  }
});

describe('player panel', () => {
  it('shows the song, a live end time and the queue', () => {
    const now = 1_700_000_000_000;
    const p = player({ current: track('Never Gonna Give You Up', { author: 'Rick Astley' }), position: 50_000, queue: [track('Next One'), track('After That')] });
    const card = renderPanel(p, { now });
    const [main, details] = texts(card);

    assert.match(main, /^\*\*\[Never Gonna Give You Up\]\(https:\/\/www\.youtube\.com\/watch\?v=id\d+\)\*\*\nRick Astley\n/);
    assert.ok(main.includes(`<t:${Math.round((now + 150_000) / 1000)}:R>`), 'counts down with a Discord timestamp');
    assert.match(details, /-# Requested by <@400000000000000004> · YouTube/);
    assert.match(details, /-# Up next \[Next One\]/);
    assert.match(details, /· 2 songs in queue · 6m$/m);
    assert.match(details, /-# Volume 100%/);
  });

  it('reflects the player state in its buttons', () => {
    const idle = renderPanel(player({ current: track('A'), queue: [track('B')] }));
    assert.equal(buttonById(idle, 'player:previous').disabled, true, 'no history yet');
    assert.equal(buttonById(idle, 'player:shuffle').disabled, true, 'one song is not enough to shuffle');
    assert.equal(buttonById(idle, 'player:toggle').emoji.name, '⏸️');
    assert.equal(buttonById(idle, 'player:loop').style, ButtonStyle.Secondary);
    assert.equal(buttonById(idle, 'player:lyrics'), undefined, 'no lyrics plugin, no lyrics button');
    assert.equal(buttonById(idle, 'player:stop').style, ButtonStyle.Danger);

    const busy = renderPanel(player({ current: track('A'), queue: many(5), history: [track('Z')], paused: true, loop: 'queue', autoplay: true, lyrics: true }));
    assert.equal(buttonById(busy, 'player:previous').disabled, false);
    assert.equal(buttonById(busy, 'player:shuffle').disabled, false);
    assert.equal(buttonById(busy, 'player:toggle').emoji.name, '▶️');
    assert.equal(buttonById(busy, 'player:loop').label, 'Loop: queue');
    assert.equal(buttonById(busy, 'player:loop').style, ButtonStyle.Primary);
    assert.equal(buttonById(busy, 'player:autoplay').style, ButtonStyle.Primary);
    assert.equal(buttonById(busy, 'player:queue').label, 'Queue · 5');
    assert.ok(buttonById(busy, 'player:lyrics'));
    assert.match(text(busy), /Paused at `1:00` of `3:20`/);
    assert.match(text(busy), /Looping the queue · Autoplay on/);
  });

  it('shows filters and the empty channel countdown', async () => {
    const p = player({ current: track('A'), paused: true });
    await setFilter(p, 'nightcore', true);
    await setFilter(p, 'bass', true);
    await setFilter(p, 'vaporwave', true); // replaces nightcore
    p.data.set('emptySince', 1_700_000_000_000);
    const content = text(renderPanel(p, { emptyLeaveDelay: 60_000 }));
    assert.match(content, /Bass boost, Vaporwave/);
    assert.doesNotMatch(content, /Nightcore/);
    assert.match(content, /Paused until someone joins · leaving <t:1700000060:R>/);
  });

  it("can't be broken by song titles", () => {
    const evil = track('**bold** [click](https://evil.example) <@123456789012345678> `code`', { author: '# Big Heading', uri: 'https://x.example/a)b' });
    const [main] = texts(renderPanel(player({ current: evil })));
    assert.ok(main.includes('\\*\\*bold\\*\\* \\[click\\]'), main);
    assert.ok(main.includes('\\<@123456789012345678\\>'));
    assert.ok(main.includes('](https://x.example/a%29b)'));
    assert.ok(main.includes('\n\\# Big Heading\n'), 'author line cannot become a header');
  });

  it('turns into the queue-ended and goodbye cards', () => {
    const p = player({ history: [track('Last song')] });
    p.data.set('queueEndedAt', 1_700_000_000_000);
    const ended = renderQueueEnd(p, p.queue.previous, { queueEndLeaveDelay: 180_000 });
    assert.match(text(ended), /The queue has ended\n-# Last played \[Last song\]/);
    assert.match(text(ended), /I'll leave <t:1700000180:R>/);
    assert.deepEqual(buttons(ended).map((b) => b.custom_id), ['player:replay', 'player:autoplay', 'player:leave']);

    p.data.set('songs', 12);
    p.data.set('since', Date.now() - 45 * 60_000);
    p.data.set('stoppedBy', '400000000000000004');
    const bye = renderGoodbye(p, 'stopped');
    assert.equal(text(bye), 'Stopped the music and left the voice channel\n-# Played 12 songs · 45m in voice · Stopped by <@400000000000000004>');
    assert.equal(buttons(bye).length, 0);
  });
});

describe('queue, sound board and lyrics', () => {
  it('pages through the queue', () => {
    const p = player({ current: track('Now'), queue: many(23) });
    const first = renderQueue(p, 0);
    assert.match(text(first), /`01` \[Queued song 1\]/);
    assert.match(text(first), /-# Page 1 of 3 · 23 songs/);
    assert.equal(buttonById(first, 'queue:page:-1').disabled, true);
    assert.equal(buttonById(first, 'queue:page:1').disabled, false);

    const last = renderQueue(p, 99);
    assert.match(text(last), /`21` \[Queued song 21\]/);
    assert.match(text(last), /Page 3 of 3/);
    assert.equal(buttonById(last, 'queue:page:3').disabled, true);
  });

  it('highlights active filters', async () => {
    const p = player({ current: track('Now'), volume: 200 });
    await setFilter(p, '8d', true);
    const board = renderSound(p, { maxVolume: 200 });
    assert.equal(buttonById(board, 'sound:filter:8d').style, ButtonStyle.Primary);
    assert.equal(buttonById(board, 'sound:filter:bass').style, ButtonStyle.Secondary);
    assert.equal(buttonById(board, 'sound:volume:up').disabled, true);
    assert.equal(buttonById(board, 'sound:clear').disabled, false);
    assert.match(text(board), /Volume \*\*200%\*\*\n-# Filters: 8D/);
  });

  it('keeps long lyrics within the message limit', () => {
    const lines = Array.from({ length: 400 }, (_, i) => ({ timestamp: i * 1000, duration: null, line: `*line* ${i} - with [markdown]`, plugin: {} }));
    const card = renderLyrics(track('Long'), { provider: 'LRCLIB', sourceName: 'lrclib', text: null, lines, plugin: {} });
    assertCard(card);
    assert.match(text(card), /-# Lyrics from LRCLIB · shortened to fit/);
  });
});

describe('formatting', () => {
  it('formats and parses times', () => {
    assert.equal(duration(0), '0:00');
    assert.equal(duration(65_000), '1:05');
    assert.equal(duration(3_723_000), '1:02:03');
    assert.equal(humanDuration(30_000), '30s');
    assert.equal(humanDuration(45 * 60_000), '45m');
    assert.equal(humanDuration(2 * 3_600_000 + 13 * 60_000), '2h 13m');
    assert.equal(parseTime('1:30'), 90_000);
    assert.equal(parseTime('1:02:03'), 3_723_000);
    assert.equal(parseTime('90'), 90_000);
    assert.equal(parseTime('2m'), 120_000);
    assert.equal(parseTime('1h2m3s'), 3_723_000);
    assert.equal(parseTime('soon'), null);
    assert.equal(parseTime(''), null);
  });

  it('truncates by character, not by byte', () => {
    assert.equal(truncate('🎶🎶🎶🎶', 3), '🎶🎶…');
    assert.equal(clean('a\n\nb   c'), 'a b c');
  });

  it('mentions commands by id once they are known', () => {
    assert.equal(command('play'), '`/play`');
    setCommandIds([{ name: 'play', id: '123' }]);
    assert.equal(command('play'), '</play:123>');
    setCommandIds([]);
  });
});

describe('commands', () => {
  it('are valid, unique and server-only', () => {
    const bodies = commandBodies();
    assert.equal(bodies.length, commands.length);
    assert.equal(new Set(bodies.map((b) => b.name)).size, bodies.length);
    for (const body of bodies) {
      assert.match(body.name, /^[a-z]{2,32}$/);
      assert.ok(body.description.length <= 100);
      assert.deepEqual(body.contexts, [0], `${body.name} only in servers`);
      for (const option of body.options ?? []) assert.ok(option.description.length <= 100, `${body.name}.${option.name}`);
    }
    const names = bodies.map((b) => b.name);
    for (const name of ['play', 'skip', 'queue', 'loop', 'volume', 'filters', 'lyrics', 'help', 'stop']) assert.ok(names.includes(name), name);
  });
});

describe('config', () => {
  it('requires a token and has sensible defaults', () => {
    assert.throws(() => loadConfig({}), ConfigError);
    const config = loadConfig({ DISCORD_TOKEN: 'x' });
    assert.equal(config.searchSource, 'youtube');
    assert.equal(config.player.volume, 80);
    assert.equal(config.player.leaveWhenEmptyAfter, 60_000);
    assert.equal(config.feed, null, 'the website feed is off unless a port is set');
    assert.deepEqual(config.nodes, [{ name: 'main', host: 'localhost', port: 2333, password: 'youshallnotpass', secure: false }]);
  });

  it('reads nodes, the live feed and validates numbers', () => {
    const config = loadConfig({
      DISCORD_TOKEN: 'x',
      LAVALINK_NODES: '[{"name":"eu","host":"eu.example.com","port":443,"password":"p","secure":true}]',
      LIVE_FEED_PORT: '8787',
      LEAVE_AFTER_QUEUE_END: '0',
    });
    assert.equal(config.nodes[0].host, 'eu.example.com');
    assert.deepEqual(config.feed, { port: 8787, host: '0.0.0.0', cors: 'https://neuzgg.github.io' });
    assert.equal(config.player.leaveAfterQueueEnd, 0);
    assert.throws(() => loadConfig({ DISCORD_TOKEN: 'x', DEFAULT_VOLUME: 'loud' }), /DEFAULT_VOLUME/);
    assert.throws(() => loadConfig({ DISCORD_TOKEN: 'x', LAVALINK_NODES: '{}' }), /LAVALINK_NODES/);
    assert.throws(() => loadConfig({ DISCORD_TOKEN: 'x', WEBSITE_URL: 'javascript:alert(1)' }), /WEBSITE_URL/);
  });
});
