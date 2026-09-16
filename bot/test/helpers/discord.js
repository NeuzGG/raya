import { ChannelType, Collection, MessageFlags } from 'discord.js';

export const GUILD_ID = '200000000000000002';
export const VOICE_ID = '300000000000000003';
export const OTHER_VOICE_ID = '300000000000000004';
export const TEXT_ID = '500000000000000005';
export const USER = { id: '400000000000000004', username: 'listener', bot: false };
export const STRANGER = { id: '400000000000000009', username: 'stranger', bot: false };

let nextId = 1000;
const snowflake = () => String(900000000000000000n + BigInt(nextId++));
const isEphemeral = (payload) => Boolean(Number(payload?.flags ?? 0) & MessageFlags.Ephemeral);

class FakeMessage {
  constructor(channel, payload, { ephemeral = false } = {}) {
    this.id = snowflake();
    this.channelId = channel.id;
    this.channel = channel;
    this.payload = payload;
    this.ephemeral = ephemeral;
    this.edits = 0;
  }

  delete() {
    return this.channel.messages.delete(this.id);
  }
}

class FakeTextChannel {
  constructor(id, name = 'general') {
    this.id = id;
    this.name = name;
    this.type = ChannelType.GuildText;
    this.lastMessageId = null;
    this.store = new Map();
    this.deleted = [];
    const channel = this;
    this.messages = {
      async edit(id, payload) {
        const message = channel.store.get(id);
        if (!message) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        message.payload = payload;
        message.edits++;
        return message;
      },
      async delete(id) {
        if (!channel.store.delete(id)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        channel.deleted.push(id);
      },
    };
  }

  isSendable() {
    return true;
  }

  async send(payload) {
    return this.post(payload);
  }

  post(payload) {
    const message = new FakeMessage(this, payload);
    this.store.set(message.id, message);
    this.lastMessageId = message.id;
    return message;
  }

  /** Messages still in the channel, oldest first */
  get visible() {
    return [...this.store.values()];
  }
}

/** A tiny fake Discord: one server with a text channel, two voice channels and a member cache. */
export function createDiscord() {
  const text = new FakeTextChannel(TEXT_ID);
  const voiceStates = new Collection();
  const guild = {
    id: GUILD_ID,
    members: { me: { id: 'bot', permissions: { has: () => true } } },
    channels: { cache: new Collection() },
    voiceStates: { cache: voiceStates },
  };

  const voiceChannel = (id, name = 'Voice') => ({
    id,
    name,
    type: ChannelType.GuildVoice,
    guild,
    joinable: true,
    permissionsFor: () => ({ has: () => true }),
    get members() {
      return new Collection(
        [...voiceStates.values()].filter((state) => state.channel.id === id).map((state) => [state.user.id, { user: state.user }]),
      );
    },
  });

  guild.channels.cache.set(VOICE_ID, voiceChannel(VOICE_ID)).set(OTHER_VOICE_ID, voiceChannel(OTHER_VOICE_ID)).set(TEXT_ID, text);

  guild.channels.create = async ({ name, type, parent = null }) => {
    const id = snowflake();
    let channel;
    if (type === ChannelType.GuildVoice) channel = voiceChannel(id, name);
    else if (type === ChannelType.GuildCategory) channel = { id, name, type, guild };
    else channel = new FakeTextChannel(id, name);
    channel.parentId = parent;
    channel.delete = async () => {
      guild.channels.cache.delete(id);
      return channel;
    };
    guild.channels.cache.set(id, channel);
    return channel;
  };

  const listeners = new Map();
  const client = {
    channels: { cache: guild.channels.cache },
    guilds: { cache: new Collection([[GUILD_ID, guild]]) },
    user: { id: '100000000000000001', displayName: 'Raya', displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1/abc.png' },
    uptime: 7_200_000,
    ws: { ping: 42 },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return client;
    },
    emit(event, ...args) {
      return Promise.all((listeners.get(event) ?? []).map((listener) => listener(...args)));
    },
  };

  guild.members.me.permissionsIn = () => ({ has: () => true });

  return {
    guild,
    text,
    channel: (id) => guild.channels.cache.get(id),
    client,
    join(user, channel = guild.channels.cache.get(VOICE_ID)) {
      voiceStates.set(user.id, { user, channel });
    },
    leave(user) {
      voiceStates.delete(user.id);
    },
    /** Someone types in a channel, the way a song request arrives. */
    async request(channelId, content, { user = USER } = {}) {
      const channel = guild.channels.cache.get(channelId);
      const message = {
        id: snowflake(),
        guildId: GUILD_ID,
        guild,
        channelId,
        channel,
        content,
        author: user,
        system: false,
        attachments: new Collection(),
        member: { voice: { channel: voiceStates.get(user.id)?.channel ?? null } },
        deleted: false,
        async delete() {
          message.deleted = true;
        },
      };
      await client.emit('messageCreate', message);
      return message;
    },
  };
}

function baseInteraction(discord, { user = USER, manager = false, roles = [], channelId = TEXT_ID } = {}) {
  const interaction = {
    guildId: GUILD_ID,
    guild: discord.guild,
    channelId,
    user,
    member: { roles: { cache: new Collection(roles.map((id) => [id, { id }])) } },
    memberPermissions: { has: () => manager },
    deferred: false,
    replied: false,
    ephemeralReplies: [],
    reply: null,
    inGuild: () => true,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
  };

  const channel = discord.channel(channelId) ?? discord.text;
  const deliver = (payload) => {
    if (isEphemeral(payload)) {
      const message = new FakeMessage(channel, payload, { ephemeral: true });
      interaction.ephemeralReplies.push(message);
      return message;
    }
    return channel.post(payload);
  };

  Object.assign(interaction, {
    async reply(payload) {
      if (interaction.deferred || interaction.replied) throw new Error('Interaction already acknowledged');
      interaction.replied = true;
      interaction.replyMessage = deliver(payload);
      return payload.withResponse ? { resource: { message: interaction.replyMessage } } : undefined;
    },
    async deferReply(options = {}) {
      if (interaction.deferred || interaction.replied) throw new Error('Interaction already acknowledged');
      interaction.deferred = true;
      interaction.replyMessage = deliver({ flags: options.flags, components: [], thinking: true });
    },
    async editReply(payload) {
      if (!interaction.deferred && !interaction.replied) throw new Error('Not replied');
      interaction.replyMessage.payload = payload;
      interaction.replyMessage.edits++;
      return interaction.replyMessage;
    },
    async followUp(payload) {
      if (!interaction.deferred && !interaction.replied) throw new Error('Not replied');
      return deliver(payload);
    },
  });
  return interaction;
}

/** A slash command interaction with `options` by name. `context` sets the channel, roles and permissions. */
export function slash(discord, commandName, options = {}, context = {}) {
  const interaction = baseInteraction(discord, context);
  Object.assign(interaction, {
    commandName,
    isChatInputCommand: () => true,
    options: {
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
      getRole: (name) => options[name] ?? null,
      getFocused: () => '',
      getSubcommand: () => context.subcommand ?? null,
    },
  });
  return interaction;
}

/** Picking an option from a dropdown on `message`. */
export function choose(discord, message, customId, values, context = {}) {
  const interaction = click(discord, message, customId, context);
  interaction.values = Array.isArray(values) ? values : [values];
  interaction.isButton = () => false;
  interaction.isStringSelectMenu = () => true;
  return interaction;
}

/** A button click on `message`. */
export function click(discord, message, customId, context = {}) {
  const interaction = baseInteraction(discord, { channelId: message.channelId, ...context });
  Object.assign(interaction, {
    customId,
    message,
    isButton: () => true,
    async update(payload) {
      if (interaction.deferred || interaction.replied) throw new Error('Interaction already acknowledged');
      interaction.replied = true;
      message.payload = payload;
      message.edits++;
      interaction.replyMessage = message; // editReply() edits the same message afterwards
    },
    async deferUpdate() {
      if (interaction.deferred || interaction.replied) throw new Error('Interaction already acknowledged');
      interaction.deferred = true;
    },
  });
  return interaction;
}
