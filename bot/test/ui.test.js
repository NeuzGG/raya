import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ButtonStyle } from 'discord.js';
import { CATEGORIES, commandBodies, commands, commandsIn, dropdownCategories, helpOverview, helpSections } from '../src/commands/index.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { setFilter } from '../src/music/filters.js';
import { notice } from '../src/ui/components.js';
import { clean, duration, humanDuration, parseTime, truncate } from '../src/ui/format.js';
import { renderDashboard, renderDashboardIdle } from '../src/ui/dashboard.js';
import { renderHelp, renderLyrics, renderStats } from '../src/ui/info.js';
import { command, setCommandIds } from '../src/ui/mentions.js';
import { renderGoodbye, renderPanel, renderQueueEnd, renderTrackProblem } from '../src/ui/panel.js';
import { renderClearConfirm, renderQueue } from '../src/ui/queue.js';
import { renderSound } from '../src/ui/sound.js';
import { assertCard, buttonById, buttons, image, menu, player, text, texts, thumbnail, track } from './helpers/cards.js';

const COVER = 'https://i.scdn.co/image/cover.png';

/** The data /help hands to the card. */
function helpFixture(overrides = {}) {
  const isAdmin = overrides.isAdmin ?? false;
  const categoryId = overrides.categoryId ?? 'music';
  const categories = dropdownCategories(isAdmin);
  const category = categories.find((entry) => entry.id === categoryId) ?? categories[0];
  return {
    name: 'Raya',
    avatar: 'https://cdn.discordapp.com/avatars/1/abc.png',
    tagline: 'music that never stops',
    announcement: { date: '2026-09-16', title: 'The official Raya bot is here', text: 'Buttons for everything.' },
    category,
    categories,
    sections: helpSections(categoryId, isAdmin),
    overview: helpOverview(isAdmin),
    stats: { servers: 3, playing: 1, ping: 42, version: '1.0.0', uptime: 7_200_000 },
    links: {
      invite: 'https://discord.com/oauth2/authorize?client_id=1',
      website: 'https://neuzgg.github.io/raya/',
      github: 'https://github.com/neuzgg/raya',
      support: null,
    },
    viewerId: '400000000000000004',
    ...overrides,
  };
}

/** The data /stats hands to the card. */
function statsFixture(overrides = {}) {
  return {
    name: 'Raya',
    avatar: 'https://cdn.discordapp.com/avatars/1/abc.png',
    servers: 4,
    players: 2,
    playing: 1,
    queued: 17,
    uptime: 7_200_000,
    memory: 128 * 1024 * 1024,
    gateway: 42,
    versions: { raya: '1.0.0', discord: '14.27.0', node: '24.20.0' },
    nodes: [
      { name: 'main', connected: true, ping: 38, players: 2, playing: 1, cpu: 0.04, memory: 512 * 1024 * 1024, uptime: 3_600_000, version: '4.1.1' },
      { name: 'backup', connected: false, ping: -1, players: 0, playing: 0, cpu: null, memory: null, uptime: null, version: null },
    ],
    ...overrides,
  };
}

/** The data the /setup dashboard is drawn from. */
function dashboardFixture(overrides = {}) {
  return {
    name: 'Raya',
    avatar: 'https://cdn.discordapp.com/avatars/1/abc.png',
    setup: { textChannelId: '500000000000000005', voiceChannelId: '300000000000000003' },
    djRoleId: '700000000000000007',
    links: { invite: 'https://discord.com/oauth2/authorize?client_id=1', website: 'https://neuzgg.github.io/raya/' },
    ...overrides,
  };
}

const many = (count) => Array.from({ length: count }, (_, i) => track(`Queued song ${i + 1}`));

describe('cards follow the design rules', () => {
  const cases = {
    'playing panel': () => renderPanel(player({ current: track('Playing', { artworkUrl: COVER }), queue: many(3), history: [track('Old')] })),
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
    help: () => renderHelp(helpFixture()),
    'help for a manager': () => renderHelp(helpFixture({ isAdmin: true, categoryId: 'admin' })),
    'help overview': () => renderHelp(helpFixture({ isAdmin: true, categoryId: 'all' })),
    'track problem': () => renderTrackProblem(track('Broken'), 'This video is unavailable'),
    notice: () => notice('Added a song', { note: 'plays next' }),
    'idle dashboard': () => renderDashboardIdle(dashboardFixture()),
    'idle dashboard without song requests': () => renderDashboardIdle(dashboardFixture({ requests: false })),
    'playing dashboard': () =>
      renderDashboard(dashboardFixture({ player: player({ current: track('On air', { artworkUrl: COVER }), queue: many(9) }) })),
    stats: () => renderStats(statsFixture()),
    'stats without nodes': () => renderStats(statsFixture({ nodes: [] })),
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
    assert.deepEqual(config.nodes, [{ name: 'main', host: 'localhost', port: 2333, password: 'youshallnotpass', secure: false }]);
  });

  it('reads nodes and validates numbers', () => {
    const config = loadConfig({
      DISCORD_TOKEN: 'x',
      LAVALINK_NODES: '[{\"name\":\"eu\",\"host\":\"eu.example.com\",\"port\":443,\"password\":\"p\",\"secure\":true}]',
      LEAVE_AFTER_QUEUE_END: '0',
    });
    assert.equal(config.nodes[0].host, 'eu.example.com');
    assert.equal(config.player.leaveAfterQueueEnd, 0);
    assert.throws(() => loadConfig({ DISCORD_TOKEN: 'x', DEFAULT_VOLUME: 'loud' }), /DEFAULT_VOLUME/);
    assert.throws(() => loadConfig({ DISCORD_TOKEN: 'x', LAVALINK_NODES: '{}' }), /LAVALINK_NODES/);
    assert.throws(() => loadConfig({ DISCORD_TOKEN: 'x', WEBSITE_URL: 'javascript:alert(1)' }), /WEBSITE_URL/);
  });
});

describe('help menu', () => {
  it('is one card with the bot, the news and a category of commands', () => {
    const card = renderHelp(helpFixture());
    const [intro, news, list, stats] = texts(card);

    assert.ok(intro.startsWith('**Raya** · music that never stops\n'), intro);
    assert.ok(intro.includes('Type **/** in the chat'));
    assert.equal(news, '**The official Raya bot is here** · 16 Sept 2026\nButtons for everything.');
    assert.ok(list.startsWith('🎵 **Music**\nIt has 8 commands\n'), list);
    assert.ok(list.includes('`/play` `query [next]` — Play a song, playlist or link'));
    assert.equal(stats, '-# 3 servers · playing in 1 · Lavalink 42ms · up 2h · raya.js 1.0.0');
    assert.equal(thumbnail(card).media.url, 'https://cdn.discordapp.com/avatars/1/abc.png');
  });

  it('counts the commands first and keeps the list behind the dropdown', () => {
    const overview = texts(renderHelp(helpFixture({ isAdmin: true, categoryId: 'all' })))[2];
    assert.ok(overview.startsWith(`**Raya has ${commands.length} commands!**\nPick a category in the dropdown below to see them.\n`), overview);
    assert.deepEqual(overview.split('\n').slice(2), [
      '🎵 **Music** · 8 commands',
      '📜 **Queue** · 6 commands',
      '🎛️ **Sound** · 2 commands',
      '💡 **Info** · 4 commands',
      '🛡️ **Admin** · 4 commands',
    ]);
    assert.ok(!overview.includes('/play'), 'no command list until a category is picked');

    const focused = texts(renderHelp(helpFixture({ categoryId: 'sound' })));
    assert.equal(focused.length, 4, 'intro, news, one category and the stats line');
    assert.ok(focused[2].startsWith('🎛️ **Sound**\nIt has 2 commands\n'));
    assert.ok(focused[2].includes('`/volume` `[level]` — Change the volume'));
  });

  it('counts only the commands a member can see', () => {
    const member = texts(renderHelp(helpFixture({ categoryId: 'all' })))[2];
    const adminCommands = commandsIn('admin').length;
    assert.ok(member.startsWith(`**Raya has ${commands.length - adminCommands} commands!**`), member);
    assert.ok(!member.includes('Admin'), 'the admin category stays hidden');
  });

  it('stays within Discord limits when a category has long mentions', () => {
    setCommandIds(commands.map((entry, index) => ({ name: entry.data.name, id: `13141516171819${String(index).padStart(5, '0')}` })));
    try {
      for (const category of CATEGORIES) assertCard(renderHelp(helpFixture({ isAdmin: true, categoryId: category.id })));
    } finally {
      setCommandIds([]);
    }
  });

  it('hides the admin category unless you can manage the server', () => {
    const member = menu(renderHelp(helpFixture()));
    assert.deepEqual(member.options.map((option) => option.value), ['all', 'music', 'queue', 'sound', 'info']);
    assert.equal(member.custom_id, 'help:400000000000000004', 'only the person who asked can switch category');
    assert.equal(member.placeholder, 'Browse the commands by category');

    const adminView = helpFixture({ isAdmin: true, categoryId: 'admin' });
    const manager = menu(renderHelp(adminView));
    assert.deepEqual(manager.options.map((option) => option.value), ['all', 'music', 'queue', 'sound', 'info', 'admin']);
    assert.ok(manager.options.find((option) => option.value === 'admin').description);
    assert.ok(text(renderHelp(adminView)).includes('🛡️ **Admin**'));
    assert.ok(text(renderHelp(adminView)).includes('Force the player to stop and leave'));
  });

  it('links out with buttons', () => {
    const links = buttons(renderHelp(helpFixture())).filter((control) => control.style === ButtonStyle.Link);
    assert.deepEqual(links.map((link) => link.label), ['Add to server', 'Website', 'GitHub']);
    assert.ok(links[0].url.startsWith('https://discord.com/oauth2/authorize'));
  });

  it('still works without news, art or links', () => {
    const card = renderHelp(helpFixture({ announcement: null, links: {}, avatar: null }));
    assertCard(card);
    assert.equal(texts(card).length, 3, 'intro, commands and stats');
    assert.equal(thumbnail(card), null);
    assert.equal(buttons(card).filter((control) => control.style === ButtonStyle.Link).length, 0);
  });

  it('covers every command', () => {
    const listed = CATEGORIES.flatMap((category) => commandsIn(category.id)).map((entry) => entry.name);
    assert.deepEqual([...listed].sort(), commands.map((command) => command.data.name).sort());
    for (const command of commands) assert.ok(command.category, `${command.data.name} has no help row`);
  });

  it('keeps admin commands behind a permission', () => {
    for (const body of commandBodies().filter((entry) => commandsIn('admin').some((row) => row.name === entry.name))) {
      assert.ok(body.default_member_permissions, `${body.name} must require a permission`);
    }
  });
});

describe('stats and dashboard', () => {
  it('lists the bot and every music server', () => {
    const [bot, nodes, versions] = texts(renderStats(statsFixture()));
    assert.ok(bot.includes('Playing in 1 server of 4'), bot);
    assert.ok(bot.includes('2 players · 17 songs queued'));
    assert.ok(bot.includes('Up 2h · 128 MB · gateway 42ms'));
    assert.ok(nodes.includes('**main** · 38ms · 2 players, 1 playing · CPU 4% · 512 MB · up 1h · Lavalink 4.1.1'), nodes);
    assert.ok(nodes.includes('**backup** · offline · 0 players, 0 playing'), nodes);
    assert.equal(versions, '-# raya.js 1.0.0 · discord.js 14.27.0 · Node 24.20.0');
  });

  it('tells people to just send a song, and who may control the music', () => {
    const card = renderDashboardIdle(dashboardFixture());
    const content = text(card);
    assert.ok(content.includes('**Raya** · nothing is playing'), content);
    assert.ok(content.includes('Join <#300000000000000003> and **send a song name or a link** in this channel.'));
    assert.ok(content.includes('Anyone can add songs; only <@&700000000000000007> can skip, stop or change the sound.'));
    assert.deepEqual(
      buttons(card).map((control) => control.custom_id ?? control.label),
      ['dashboard:help', 'Add to server', 'Website'],
    );
    assert.equal(image(card), null, 'no picture until something plays');

    const commandsOnly = text(renderDashboardIdle(dashboardFixture({ requests: false })));
    assert.ok(commandsOnly.includes('start the music with `/play`'), commandsOnly);
    assert.ok(!commandsOnly.includes('send a song name'), 'it never promises something that is turned off');
  });

  it('becomes the player with big cover art and what is up next', () => {
    const playing = player({ current: track('On air', { artworkUrl: COVER }), queue: many(9), volume: 90, loop: 'queue' });
    playing.data.set('songs', 4);
    playing.data.set('since', Date.now() - 20 * 60_000);
    const card = renderDashboard(dashboardFixture({ player: playing, listeners: 3 }));
    assertCard(card);
    const [song, next, footer] = texts(card);

    assert.ok(song.startsWith('**[On air]'), song);
    assert.deepEqual(image(card), { media: { url: COVER }, description: 'Cover art for On air' });
    assert.ok(next.startsWith('**Up next**\n`1` [Queued song 1]'), next);
    assert.ok(next.includes('-# 9 songs · 32m of music left · 4 more not shown'), next);
    assert.ok(footer.includes('Volume 90% · Looping the queue'), footer);
    assert.ok(footer.includes('3 people listening · 4 songs played · 20m in voice'), footer);

    const ids = buttons(card).map((control) => control.custom_id ?? control.label);
    assert.ok(ids.includes('player:toggle') && ids.includes('player:skip') && ids.includes('player:queue'));
    assert.ok(ids.includes('dashboard:help'), 'the links row stays');
  });

  it('says when the queue will finish, but only when it really will', () => {
    const now = 1_700_000_000_000;
    const straight = player({ current: track('Now'), queue: many(3), position: 20_000 });
    const ends = Math.round((now + 180_000 + 3 * 200_000) / 1000);
    assert.ok(
      texts(renderDashboard(dashboardFixture({ player: straight, now })))[1].includes(`ends around <t:${ends}:t>`),
      texts(renderDashboard(dashboardFixture({ player: straight, now })))[1],
    );

    for (const endless of [{ loop: 'queue' }, { autoplay: true }]) {
      const looping = player({ current: track('Now'), queue: many(3), position: 20_000, ...endless });
      assert.ok(!texts(renderDashboard(dashboardFixture({ player: looping, now })))[1].includes('ends around'));
    }
  });
});

describe('cover art', () => {
  it('sits beside the song on the player', () => {
    const withArt = renderPanel(player({ current: track('Art', { artworkUrl: COVER }) }));
    assert.deepEqual(thumbnail(withArt), { type: 11, media: { url: COVER }, description: 'Cover art for Art' });
    assert.equal(thumbnail(renderPanel(player({ current: track('No art') }))), null, 'no art, no section');
  });

  it('is never an unsafe URL', () => {
    const evil = renderPanel(player({ current: track('Sneaky', { artworkUrl: 'javascript:alert(1)' }) }));
    assert.equal(thumbnail(evil), null);
  });

  it('shows the queue cover and the jump dropdown', () => {
    const p = player({ current: track('Now', { artworkUrl: COVER }), queue: many(12) });
    const card = renderQueue(p, 1);
    assertCard(card);
    assert.equal(thumbnail(card).media.url, COVER);

    const jump = menu(card);
    assert.equal(jump.custom_id, 'queue:jump:1');
    assert.deepEqual(jump.options.map((option) => option.value), ['11', '12']);
    assert.ok(jump.options[0].label.startsWith('11. Queued song 11'));
    assert.equal(jump.options[0].description, 'Test Artist · 3:20');
    assert.equal(menu(renderQueue(player({ current: track('Alone') }))), null, 'no dropdown with an empty queue');
  });
});
