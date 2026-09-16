import { Events, PermissionFlagsBits } from 'discord.js';
import { describeError, isUnexpected } from '../interactions/errors.js';
import { assertCanJoin, UserError } from './guards.js';
import { addedCard } from '../ui/added.js';
import { create, notice } from '../ui/components.js';
import { clean, trackAuthor, trackLink } from '../ui/format.js';

/** How long the confirmation under a song request stays before it is tidied away. */
const NOTICE_TTL = 12_000;
const MAX_QUERY = 500;

/** Post a short card in the request channel and clean it up again. */
async function flash(channel, container, log) {
  const message = await channel.send(create(container)).catch((error) => {
    log.debug(`[requests] could not answer in ${channel.id}: ${error.message}`);
    return null;
  });
  if (message) setTimeout(() => message.delete().catch(() => undefined), NOTICE_TTL).unref?.();
}

async function playRequest(bot, message, query) {
  const channel = message.member?.voice?.channel;
  if (!channel) throw new UserError(`${message.author} join a voice channel first, then send the song again.`);
  assertCanJoin(channel);
  if (bot.raya.readyNodes.length === 0) throw new UserError('The music server is starting up. Try again in a few seconds.');

  const existing = bot.raya.getPlayer(message.guildId);
  if (existing && !existing.destroyed && existing.voiceChannelId && existing.voiceChannelId !== channel.id && existing.current) {
    throw new UserError(`I'm already playing in <#${existing.voiceChannelId}>. Join me there!`);
  }

  const result = await bot.raya.search(query, { requester: message.author });
  if (result.type === 'error') throw new UserError(`Couldn't load that: ${clean(result.exception?.message ?? 'unknown error', 150)}`);
  if (result.tracks.length === 0) throw new UserError(`No results for **${clean(query, 80)}**. Try other words or a link.`);

  const player = await bot.raya.join({
    guildId: message.guildId,
    voiceChannelId: channel.id,
    textChannelId: message.channelId,
  });
  player.setTextChannel(message.channelId);

  const tracks = result.type === 'playlist' ? result.tracks : result.tracks.slice(0, 1);
  const { added, started } = await player.enqueue(tracks);
  if (added.length === 0) return;

  // The dashboard shows the song that started; a queued song gets a short confirmation.
  if (started && added.length === 1) {
    await flash(message.channel, notice(`Playing ${trackLink(added[0], 70)} · ${trackAuthor(added[0], 40)}`), bot.log);
    return;
  }
  await flash(message.channel, addedCard(player, result, added, { playNext: false, total: tracks.length }), bot.log);
}

/**
 * In a `/setup` request channel, anything people type is a song: a title, a link or a playlist.
 * The message is tidied away and the dashboard above becomes the player.
 *
 * Needs the Message Content intent; without it every message arrives empty and the bot says so once.
 */
export function attachSongRequests(bot) {
  let warned = false;

  bot.client.on(Events.MessageCreate, async (message) => {
    if (message.author?.bot || !message.guildId || message.system) return;
    const setup = bot.settings?.setup(message.guildId);
    if (!setup?.textChannelId || message.channelId !== setup.textChannelId) return;

    const query = (message.content ?? '').trim().slice(0, MAX_QUERY);
    const canDelete = message.guild?.members.me?.permissionsIn(message.channelId)?.has(PermissionFlagsBits.ManageMessages);
    if (canDelete) void message.delete().catch(() => undefined);

    if (!query) {
      if (!warned && !message.attachments?.size) {
        warned = true;
        bot.log.warn(
          'A song request arrived empty. Turn on the Message Content intent in the Developer Portal (Bot > Privileged Gateway Intents), or set SONG_REQUESTS=false in bot/.env.',
        );
      }
      return;
    }

    try {
      await playRequest(bot, message, query);
    } catch (error) {
      if (isUnexpected(error)) bot.log.error(`song request "${query}" failed:`, error);
      await flash(message.channel, notice(describeError(error)), bot.log);
    }
  });
}
