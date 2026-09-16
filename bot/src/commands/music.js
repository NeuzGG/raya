import { SlashCommandBuilder } from 'discord.js';
import { isUrl } from 'raya.js';
import { assertCanJoin, getControllablePlayer, getPlayer, memberVoiceChannel, UserError } from '../music/guards.js';
import { create, edit, notice } from '../ui/components.js';
import { artwork, clean, duration, humanDuration, length, parseTime, plural, safeUrl, trackAuthor, trackLink, truncate } from '../ui/format.js';
import { addedCard } from '../ui/added.js';
import { queuePositionAutocomplete } from './shared.js';

const AUTOCOMPLETE_TIMEOUT = 2500;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function humansIn(guild, channelId) {
  return guild.channels.cache.get(channelId)?.members?.filter((member) => !member.user.bot).size ?? 0;
}

const play = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song, playlist or link, or add it to the queue')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('A song name, or a YouTube, Spotify, SoundCloud... link')
        .setRequired(true)
        .setMaxLength(500)
        .setAutocomplete(true),
    )
    .addBooleanOption((option) => option.setName('next').setDescription('Play it right after the current song')),

  async autocomplete({ interaction, bot }) {
    const query = interaction.options.getFocused().trim();
    if (query.length < 2 || isUrl(query) || bot.raya.readyNodes.length === 0) return interaction.respond([]);
    const result = await withTimeout(bot.raya.search(query), AUTOCOMPLETE_TIMEOUT).catch(() => null);
    if (!result || result.tracks.length === 0) return interaction.respond([]);
    if (result.type === 'playlist') {
      return interaction.respond([{ name: truncate(`Playlist: ${result.playlist?.name} (${plural(result.tracks.length, 'song')})`, 100), value: truncate(query, 100) }]);
    }
    const choices = result.tracks.slice(0, 10).map((track) => ({
      name: truncate(`${track.info.title} · ${track.info.author} (${length(track)})`, 100),
      value: track.info.uri && track.info.uri.length <= 100 ? track.info.uri : truncate(`${track.info.title} ${track.info.author}`, 100),
    }));
    return interaction.respond(choices);
  },

  async run({ interaction, bot }) {
    const channel = memberVoiceChannel(interaction);
    if (!channel) throw new UserError('Join a voice channel first, then use this again.');
    const existing = bot.raya.getPlayer(interaction.guildId);
    if (existing && !existing.destroyed && existing.voiceChannelId && existing.voiceChannelId !== channel.id) {
      if (existing.current && humansIn(interaction.guild, existing.voiceChannelId) > 0) {
        throw new UserError(`I'm already playing in <#${existing.voiceChannelId}>. Join me there!`);
      }
    }
    assertCanJoin(channel);
    if (bot.raya.readyNodes.length === 0) throw new UserError('The music server is starting up. Try again in a few seconds.');

    await interaction.deferReply();
    const query = interaction.options.getString('query', true);
    const playNext = interaction.options.getBoolean('next') ?? false;
    const result = await bot.raya.search(query, { requester: interaction.user });
    if (result.type === 'error') throw new UserError(`Couldn't load that: ${clean(result.exception?.message ?? 'unknown error', 150)}`);
    if (result.tracks.length === 0) throw new UserError(`No results for **${clean(query, 80)}**. Try other words or a link.`);

    const home = bot.settings?.setup(interaction.guildId)?.textChannelId ?? interaction.channelId;
    const player = await bot.raya.join({
      guildId: interaction.guildId,
      voiceChannelId: channel.id,
      textChannelId: home,
    });
    player.setTextChannel(home);

    const tracks = result.type === 'playlist' ? result.tracks : result.tracks.slice(0, 1);
    const claim = bot.panels.claim(interaction);
    let outcome;
    try {
      outcome = await player.enqueue(tracks, { index: playNext && player.current ? 0 : undefined });
    } catch (error) {
      claim.settle('released');
      throw error;
    }

    if (!outcome.started) {
      const added = addedCard(player, result, outcome.added, { playNext, total: tracks.length });
      if (claim.settle('released')) await interaction.editReply(edit(added));
      else await interaction.followUp(create(added));
      return;
    }

    const state = await claim.settled;
    if (state === 'consumed') {
      if (outcome.added.length > 1) await interaction.followUp(create(addedCard(player, result, outcome.added, { playNext, total: tracks.length })));
      return;
    }
    if (state === 'failed') return;
    const [first] = outcome.added;
    await interaction.editReply(
      edit(
        notice(`Playing ${trackLink(first, 70)} · ${trackAuthor(first, 40)}`, {
          note: length(first),
          thumbnail: { url: artwork(first), description: `Cover art for ${first.info.title}` },
        }),
      ),
    );
  },
};

const nowplaying = {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Bring the player to the bottom of the chat'),
  async run({ interaction, bot }) {
    await bot.panels.repost(getPlayer(bot, interaction), interaction);
  },
};

const pause = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause the music'),
  async run({ interaction, bot }) {
    const player = getControllablePlayer(bot, interaction, { needsTrack: true });
    if (player.paused) throw new UserError('The music is already paused.');
    await player.pause();
    bot.panels.refresh(player);
    await interaction.reply(create(notice('Paused the music')));
  },
};

const resume = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume the music'),
  async run({ interaction, bot }) {
    const player = getControllablePlayer(bot, interaction, { needsTrack: true });
    if (!player.paused) throw new UserError("The music isn't paused.");
    await player.resume();
    player.data.delete('emptySince');
    bot.panels.refresh(player);
    await interaction.reply(create(notice('Resumed the music')));
  },
};

const skip = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song')
    .addIntegerOption((option) =>
      option.setName('to').setDescription('Jump to this song in the queue').setMinValue(1).setAutocomplete(true),
    ),
  autocomplete: queuePositionAutocomplete,
  async run({ interaction, bot }) {
    const player = getControllablePlayer(bot, interaction);
    const to = interaction.options.getInteger('to');
    if (!player.current && player.queue.isEmpty) throw new UserError('There is nothing to skip.');
    if (to !== null) {
      const target = player.queue.at(to - 1);
      if (!target) throw new UserError(`The queue only has ${plural(player.queue.size, 'song')}.`);
      await player.skip(to);
      await interaction.reply(create(notice(`Skipped to ${trackLink(target, 70)}`, { note: to > 1 ? `${plural(to - 1, 'song')} skipped along the way` : undefined })));
      return;
    }
    const skipped = player.current;
    await player.skip();
    await interaction.reply(create(notice(skipped ? `Skipped ${trackLink(skipped, 70)}` : 'Skipped')));
  },
};

const previous = {
  data: new SlashCommandBuilder().setName('previous').setDescription('Play the previous song again'),
  async run({ interaction, bot }) {
    const player = getControllablePlayer(bot, interaction);
    const track = await player.previous();
    if (!track) throw new UserError('There is no previous song.');
    await interaction.reply(create(notice(`Playing ${trackLink(track, 70)} again`)));
  },
};

const seek = {
  data: new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Jump to a time in the current song')
    .addStringOption((option) =>
      option.setName('time').setDescription('Like 1:30, 90, 2m, or +10 / -10 to jump forward or back').setRequired(true).setMaxLength(20),
    ),
  async run({ interaction, bot }) {
    const player = getControllablePlayer(bot, interaction, { needsTrack: true });
    const track = player.current;
    if (!track.info.isSeekable || track.info.isStream) throw new UserError("You can't jump around in this song.");
    const raw = interaction.options.getString('time', true).trim();
    const relative = /^([+-])\s*(.+)$/.exec(raw);
    const amount = parseTime(relative ? relative[2] : raw);
    if (amount === null) throw new UserError('Use a time like `1:30`, `90`, `2m`, `+10` or `-10`.');
    const target = relative ? player.position + (relative[1] === '+' ? amount : -amount) : amount;
    const clamped = Math.max(0, Math.min(target, track.info.length));
    await player.seek(clamped);
    bot.panels.refresh(player);
    await interaction.reply(create(notice(`Jumped to \`${duration(clamped)}\` of \`${duration(track.info.length)}\``)));
  },
};

const stop = {
  data: new SlashCommandBuilder().setName('stop').setDescription('Stop the music, clear the queue and leave'),
  async run({ interaction, bot }) {
    const player = getControllablePlayer(bot, interaction);
    player.data.set('stoppedBy', interaction.user.id);
    await player.destroy({ reason: 'stopped' });
    await interaction.reply(create(notice('Stopped the music. See you next time!')));
  },
};

export default [play, nowplaying, pause, resume, skip, previous, seek, stop];
