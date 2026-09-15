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
  constructor(id) {
    this.id = id;
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
    members: { me: { id: 'bot' } },
    channels: { cache: new Collection() },
    voiceStates: { cache: voiceStates },
  };
  const voiceChannel = (id) => ({
    id,
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
  const voice = voiceChannel(VOICE_ID);
  const otherVoice = voiceChannel(OTHER_VOICE_ID);
  guild.channels.cache.set(VOICE_ID, voice).set(OTHER_VOICE_ID, otherVoice).set(TEXT_ID, text);

  return {
    guild,
    text,
    client: { channels: { cache: guild.channels.cache }, guilds: { cache: new Collection([[GUILD_ID, guild]]) } },
    join(user, channel = voice) {
      voiceStates.set(user.id, { user, channel });
    },
    leave(user) {
      voiceStates.delete(user.id);
    },
  };
}

function baseInteraction(discord, user) {
  const interaction = {
    guildId: GUILD_ID,
    guild: discord.guild,
    channelId: TEXT_ID,
    user,
    memberPermissions: { has: () => false },
    deferred: false,
    replied: false,
    ephemeralReplies: [],
    reply: null,
    inGuild: () => true,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => false,
  };

  const deliver = (payload) => {
    if (isEphemeral(payload)) {
      const message = new FakeMessage(discord.text, payload, { ephemeral: true });
      interaction.ephemeralReplies.push(message);
      return message;
    }
    return discord.text.post(payload);
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

/** A slash command interaction with `options` by name. */
export function slash(discord, commandName, options = {}, { user = USER } = {}) {
  const interaction = baseInteraction(discord, user);
  Object.assign(interaction, {
    commandName,
    isChatInputCommand: () => true,
    options: {
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
      getFocused: () => '',
    },
  });
  return interaction;
}

/** A button click on `message`. */
export function click(discord, message, customId, { user = USER } = {}) {
  const interaction = baseInteraction(discord, user);
  Object.assign(interaction, {
    customId,
    message,
    isButton: () => true,
    async update(payload) {
      if (interaction.deferred || interaction.replied) throw new Error('Interaction already acknowledged');
      interaction.replied = true;
      message.payload = payload;
      message.edits++;
    },
    async deferUpdate() {
      if (interaction.deferred || interaction.replied) throw new Error('Interaction already acknowledged');
      interaction.deferred = true;
    },
  });
  return interaction;
}
