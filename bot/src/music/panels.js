import { create, edit } from '../ui/components.js';
import { renderGoodbye, renderPanel, renderQueueEnd, renderTrackProblem } from '../ui/panel.js';

const GONE = new Set([10003, 10008, 50001]); // Unknown Channel, Unknown Message, Missing Access
const CLAIM_TIMEOUT = 10_000;
const PROBLEM_NOTICE_TTL = 15_000;

/**
 * Keeps one live player message per server.
 *
 * - A new song edits the panel in place when it's still the newest message in the channel,
 *   otherwise the panel moves to the bottom (new message, old one deleted).
 * - `/play` can claim the next panel so its own reply becomes the player instead of a second message.
 * - Changes are coalesced and every Discord call for a server runs in order.
 * - The panel's location is stored in `player.data`, so it survives restarts with the player.
 */
export class Panels {
  #client;
  #raya;
  #log;
  #options;
  #chains = new Map();
  #timers = new Map();
  #claims = new Map();
  #lastProblem = new Map();

  constructor({ client, raya, log, emptyLeaveDelay = 0, queueEndLeaveDelay = 0 }) {
    this.#client = client;
    this.#raya = raya;
    this.#log = log;
    this.#options = { emptyLeaveDelay, queueEndLeaveDelay };
  }

  attach() {
    const raya = this.#raya;
    raya.on('trackStart', (player) => {
      player.data.delete('queueEndedAt');
      player.data.set('songs', (player.data.get('songs') ?? 0) + 1);
      if (!player.data.has('since')) player.data.set('since', Date.now());
      this.#task(player, () => this.#show(player, () => renderPanel(player, this.#options)));
    });
    raya.on('queueEnd', (player, lastTrack) => {
      player.data.set('queueEndedAt', Date.now());
      this.#task(player, () => this.#show(player, () => renderQueueEnd(player, lastTrack, this.#options)));
    });
    raya.on('playerDestroy', (player, reason) => {
      this.cancelRefresh(player);
      this.#claims.get(player.guildId)?.settle('destroyed');
      this.#task(player, () => this.#finish(player, reason));
    });
    raya.on('queueUpdate', (player) => this.refresh(player, 1500));
    raya.on('voiceChannelEmpty', (player) => {
      player.data.set('emptySince', Date.now());
      this.refresh(player);
    });
    raya.on('voiceChannelFilled', (player) => {
      player.data.delete('emptySince');
      this.refresh(player);
    });
    raya.on('playerResume', (player) => this.refresh(player));
    raya.on('trackError', (player, track, exception) => this.#task(player, () => this.#problem(player, track, exception?.message)));
    raya.on('trackStuck', (player, track) => this.#task(player, () => this.#problem(player, track, 'The song got stuck')));
    return this;
  }

  /** Render the player for this server (used by buttons and commands). */
  render(player) {
    return player.current
      ? renderPanel(player, this.#options)
      : renderQueueEnd(player, player.queue.previous ?? null, this.#options);
  }

  /** Use this message as the server's panel from now on. */
  adopt(player, message) {
    this.#remember(player, message);
  }

  /**
   * Let an interaction's deferred reply become the next panel. `settled` resolves with
   * 'consumed' (the reply is now the panel), 'failed' (the song couldn't start and the reply says so),
   * 'replaced' (a newer claim took over), 'destroyed' or 'expired'.
   */
  claim(interaction) {
    const guildId = interaction.guildId;
    this.#claims.get(guildId)?.settle('replaced');
    let resolve;
    const claim = {
      interaction,
      state: 'pending',
      settled: new Promise((r) => (resolve = r)),
      settle: (state) => {
        if (claim.state !== 'pending') return false;
        claim.state = state;
        clearTimeout(claim.timer);
        if (this.#claims.get(guildId) === claim) this.#claims.delete(guildId);
        resolve(state);
        return true;
      },
    };
    claim.timer = setTimeout(() => claim.settle('expired'), CLAIM_TIMEOUT);
    claim.timer.unref?.();
    this.#claims.set(guildId, claim);
    return claim;
  }

  /** Re-render the panel after a short delay; calls within the delay are merged into one edit. */
  refresh(player, delay = 300) {
    const guildId = player.guildId;
    clearTimeout(this.#timers.get(guildId));
    const timer = setTimeout(() => {
      this.#timers.delete(guildId);
      this.#task(player, () => this.#update(player));
    }, delay);
    timer.unref?.();
    this.#timers.set(guildId, timer);
  }

  cancelRefresh(player) {
    clearTimeout(this.#timers.get(player.guildId));
    this.#timers.delete(player.guildId);
  }

  /** Post the panel as a new message at the bottom of the channel (or as an interaction reply). */
  async repost(player, interaction) {
    const container = this.render(player);
    const previous = player.data.get('panel');
    const response = await interaction.reply({ ...create(container), withResponse: true });
    const message = response.resource?.message;
    if (!message) return;
    this.#remember(player, message);
    if (previous && previous.messageId !== message.id) await this.#delete(previous);
  }

  // ==================== Internals ====================

  #task(player, fn) {
    const guildId = player.guildId;
    const next = (this.#chains.get(guildId) ?? Promise.resolve())
      .then(fn)
      .catch((error) => this.#log.warn(`[panel ${guildId}]`, error?.message ?? error));
    this.#chains.set(guildId, next);
    next.then(() => {
      if (this.#chains.get(guildId) === next) this.#chains.delete(guildId);
    });
    return next;
  }

  #remember(player, message) {
    player.data.set('panel', { channelId: message.channelId, messageId: message.id });
  }

  async #show(player, render) {
    if (player.destroyed) return;
    this.cancelRefresh(player);
    const previous = player.data.get('panel');

    const claim = this.#claims.get(player.guildId);
    if (claim?.settle('consumed')) {
      try {
        const message = await claim.interaction.editReply(edit(render()));
        this.#remember(player, message);
        if (previous && previous.messageId !== message.id) await this.#delete(previous);
        return;
      } catch (error) {
        this.#log.debug(`[panel ${player.guildId}] claimed reply failed: ${error.message}`);
      }
    }

    if (previous && previous.channelId === player.textChannelId && this.#isNewest(previous)) {
      if (await this.#edit(player, previous, render())) return;
    }

    const channel = player.textChannelId ? this.#client.channels.cache.get(player.textChannelId) : null;
    if (!channel?.isSendable?.()) return;
    try {
      const message = await channel.send(create(render()));
      this.#remember(player, message);
    } catch (error) {
      this.#log.debug(`[panel ${player.guildId}] send failed: ${error.message}`);
      return;
    }
    if (previous) await this.#delete(previous);
  }

  async #update(player) {
    if (player.destroyed) return;
    const panel = player.data.get('panel');
    if (panel) await this.#edit(player, panel, this.render(player));
  }

  async #finish(player, reason) {
    const panel = player.data.get('panel');
    if (panel) await this.#edit(player, panel, renderGoodbye(player, reason));
  }

  async #problem(player, track, message) {
    const claim = this.#claims.get(player.guildId);
    if (claim?.settle('failed')) {
      await claim.interaction.editReply(edit(renderTrackProblem(track, message))).catch(() => undefined);
      return;
    }
    const last = this.#lastProblem.get(player.guildId) ?? 0;
    if (Date.now() - last < 5000) return;
    this.#lastProblem.set(player.guildId, Date.now());
    const channel = player.textChannelId ? this.#client.channels.cache.get(player.textChannelId) : null;
    if (!channel?.isSendable?.()) return;
    const sent = await channel.send(create(renderTrackProblem(track, message))).catch(() => null);
    if (sent) setTimeout(() => sent.delete().catch(() => undefined), PROBLEM_NOTICE_TTL).unref?.();
  }

  #isNewest(panel) {
    return this.#client.channels.cache.get(panel.channelId)?.lastMessageId === panel.messageId;
  }

  async #edit(player, panel, container) {
    const channel = this.#client.channels.cache.get(panel.channelId);
    if (!channel?.messages) {
      player.data.delete('panel');
      return false;
    }
    try {
      await channel.messages.edit(panel.messageId, edit(container));
      return true;
    } catch (error) {
      if (GONE.has(error.code)) {
        if (player.data.get('panel')?.messageId === panel.messageId) player.data.delete('panel');
      } else {
        this.#log.debug(`[panel ${player.guildId}] edit failed: ${error.message}`);
      }
      return false;
    }
  }

  async #delete(panel) {
    const channel = this.#client.channels.cache.get(panel.channelId);
    await channel?.messages?.delete(panel.messageId).catch(() => undefined);
  }
}
