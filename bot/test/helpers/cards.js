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

function contentOf(component) {
  if (component.type === ComponentType.TextDisplay) return [component.content];
  if (component.type === ComponentType.Section) return component.components.map((text) => text.content);
  return [];
}

export function texts(input) {
  return json(input).components.flatMap(contentOf);
}

export function text(input) {
  return texts(input).join('\n');
}

export function controls(input) {
  return json(input)
    .components.filter((component) => component.type === ComponentType.ActionRow)
    .flatMap((row) => row.components);
}

export { controls as buttons };

export function buttonById(input, id) {
  return controls(input).find((control) => control.custom_id === id);
}

/** The dropdown of a card, or null. */
export function menu(input) {
  return controls(input).find((control) => control.type === ComponentType.StringSelect) ?? null;
}

/** The cover art (section thumbnail) of a card, or null. */
export function thumbnail(input) {
  const section = json(input).components.find((component) => component.type === ComponentType.Section);
  return section ? section.accessory : null;
}

/** The full-width picture of a card, or null. */
export function image(input) {
  const gallery = json(input).components.find((component) => component.type === ComponentType.MediaGallery);
  return gallery ? gallery.items[0] : null;
}

/**
 * The Raya card rules: one container with no accent color, content made of text and dividers
 * (the first block may carry cover art as a section thumbnail, never a markdown header),
 * controls at the bottom, all within Discord's limits.
 */
export function assertCard(input) {
  const card = json(input);
  assert.equal(card.type, ComponentType.Container);
  assert.equal(card.accent_color, undefined, 'no accent color');
  assert.ok(card.components.length > 0);
  assert.ok(
    card.components[0].type === ComponentType.TextDisplay || card.components[0].type === ComponentType.Section,
    'starts with content, not a separator or header block',
  );

  let seenRow = false;
  let count = 1;
  let characters = 0;
  const ids = new Set();

  const checkText = (component) => {
    count++;
    assert.equal(component.type, ComponentType.TextDisplay, `only text in content (got type ${component.type})`);
    characters += component.content.length;
    for (const line of component.content.split('\n')) {
      assert.ok(!/^#{1,3}\s/.test(line), `no markdown headers: "${line}"`);
    }
  };

  card.components.forEach((component, index) => {
    if (component.type === ComponentType.ActionRow) {
      count++;
      seenRow = true;
      assert.ok(component.components.length >= 1 && component.components.length <= 5, 'rows hold 1-5 components');
      for (const control of component.components) {
        count++;
        assert.ok(
          control.type === ComponentType.Button || control.type === ComponentType.StringSelect,
          'rows hold buttons or a dropdown',
        );
        if (control.custom_id) {
          assert.ok(!ids.has(control.custom_id), `duplicate id ${control.custom_id}`);
          assert.ok(control.custom_id.length <= 100);
          ids.add(control.custom_id);
        }
        if (control.label) assert.ok(control.label.length <= 80);
        if (control.type === ComponentType.StringSelect) {
          assert.equal(component.components.length, 1, 'a dropdown gets its own row');
          assert.ok(control.options.length >= 1 && control.options.length <= 25, '1-25 options');
          const values = new Set();
          for (const option of control.options) {
            assert.ok(option.label.length <= 100 && option.value.length <= 100);
            assert.ok(!option.description || option.description.length <= 100);
            assert.ok(!values.has(option.value), `duplicate option ${option.value}`);
            values.add(option.value);
          }
        }
      }
      return;
    }

    assert.ok(!seenRow, 'controls come last');

    if (component.type === ComponentType.MediaGallery) {
      count++;
      assert.equal(card.components[index - 1]?.type, ComponentType.TextDisplay, 'a picture follows the text it belongs to');
      assert.ok(component.items.length >= 1 && component.items.length <= 10, '1-10 pictures');
      for (const item of component.items) {
        assert.match(item.media.url, /^https:\/\//, 'pictures are https URLs');
        assert.ok(item.description?.length > 0, 'pictures have alt text');
      }
      return;
    }

    if (component.type === ComponentType.Separator) {
      count++;
      const before = card.components[index - 1]?.type;
      const after = card.components[index + 1]?.type;
      assert.ok(
        before === ComponentType.TextDisplay || before === ComponentType.Section || before === ComponentType.MediaGallery,
        'separators follow content',
      );
      assert.ok(
        after === ComponentType.TextDisplay || after === ComponentType.Section || after === ComponentType.ActionRow,
        'separators split content',
      );
      return;
    }

    if (component.type === ComponentType.Section) {
      count++;
      assert.ok(component.components.length >= 1 && component.components.length <= 3, 'a section holds 1-3 texts');
      component.components.forEach(checkText);
      count++;
      assert.equal(component.accessory.type, ComponentType.Thumbnail, 'the only accessory is cover art');
      assert.match(component.accessory.media.url, /^https:\/\//, 'cover art is an https URL');
      assert.ok(component.accessory.description?.length > 0, 'cover art has alt text');
      return;
    }

    checkText(component);
  });

  assert.ok(count <= 40, `at most 40 components (got ${count})`);
  assert.ok(characters <= 4000, `at most 4000 characters of text (got ${characters})`);
}
