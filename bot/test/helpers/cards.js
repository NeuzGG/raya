import assert from 'node:assert/strict';
import { ComponentType } from 'discord.js';
import { Filters, Queue } from 'raya.js';

let nextTrack = 0;

export function track(title, { requester = { id: '400000000000000004', username: 'listener' }, ...info } = {}) {
  nextTrack++;
  return {
    encoded: `encoded-${nextTrack}`,
    info: {
      title,
      author: 'Test Artist',
      length: 200_000,
      identifier: `id-${nextTrack}`,
      isStream: false,
      isSeekable: true,
      uri: `https://www.youtube.com/watch?v=id${nextTrack}`,
      artworkUrl: null,
      isrc: null,
      sourceName: 'youtube',
      position: 0,
      ...info,
    },
    pluginInfo: {},
    userData: {},
    requester,
  };
}

/** A player-shaped object backed by Raya's real Queue and Filters. */
export function player({ current = null, queue = [], history = [], lyrics = false, ...state } = {}) {
  const fake = {
    guildId: '200000000000000002',
    voiceChannelId: '300000000000000003',
    textChannelId: '500000000000000005',
    raya: { emit() {} },
    node: { info: { plugins: lyrics ? [{ name: 'lavalyrics-plugin', version: '1.0.0' }] : [] } },
    data: new Map(),
    destroyed: false,
    paused: false,
    position: 60_000,
    volume: 100,
    loop: 'off',
    autoplay: false,
    _update: async () => ({}),
    ...state,
  };
  fake.current = current;
  fake.queue = new Queue(fake, 10_000, 50);
  if (queue.length) fake.queue.add(queue);
  for (const played of history) fake.queue._pushHistory(played);
  fake.filters = new Filters(fake);
  return fake;
}

/** The JSON of the single container in a message payload or a ContainerBuilder. */
export function json(input) {
  const container = typeof input?.toJSON === 'function' ? input : input.components[0];
  return container.toJSON();
}

export function texts(input) {
  return json(input).components.filter((c) => c.type === ComponentType.TextDisplay).map((c) => c.content);
}

export function text(input) {
  return texts(input).join('\n');
}

export function buttons(input) {
  return json(input)
    .components.filter((c) => c.type === ComponentType.ActionRow)
    .flatMap((row) => row.components);
}

export function buttonById(input, id) {
  return buttons(input).find((b) => b.custom_id === id);
}

/**
 * The Raya card rules: one container with no accent color, text displays and dividers only
 * (content first, never a markdown header), buttons at the bottom, within Discord's limits.
 */
export function assertCard(input) {
  const card = json(input);
  assert.equal(card.type, ComponentType.Container);
  assert.equal(card.accent_color, undefined, 'no accent color');
  assert.ok(card.components.length > 0);
  assert.equal(card.components[0].type, ComponentType.TextDisplay, 'starts with content, not a separator or header block');

  let seenRow = false;
  let count = 1;
  let characters = 0;
  const ids = new Set();
  card.components.forEach((component, index) => {
    count++;
    if (component.type === ComponentType.ActionRow) {
      seenRow = true;
      assert.ok(component.components.length >= 1 && component.components.length <= 5, 'rows hold 1-5 buttons');
      for (const b of component.components) {
        count++;
        assert.equal(b.type, ComponentType.Button);
        if (b.custom_id) {
          assert.ok(!ids.has(b.custom_id), `duplicate button id ${b.custom_id}`);
          assert.ok(b.custom_id.length <= 100);
          ids.add(b.custom_id);
        }
        if (b.label) assert.ok(b.label.length <= 80);
      }
      return;
    }
    assert.ok(!seenRow, 'buttons come last');
    if (component.type === ComponentType.Separator) {
      const before = card.components[index - 1]?.type;
      const after = card.components[index + 1]?.type;
      assert.equal(before, ComponentType.TextDisplay, 'separators follow text');
      assert.ok(after === ComponentType.TextDisplay || after === ComponentType.ActionRow, 'separators split content');
      return;
    }
    assert.equal(component.type, ComponentType.TextDisplay, `only text, separators and buttons (got type ${component.type})`);
    characters += component.content.length;
    for (const line of component.content.split('\n')) {
      assert.ok(!/^#{1,3}\s/.test(line), `no markdown headers: "${line}"`);
    }
  });
  assert.ok(count <= 40, `at most 40 components (got ${count})`);
  assert.ok(characters <= 4000, `at most 4000 characters of text (got ${characters})`);
}
