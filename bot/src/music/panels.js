import { create, edit, notice } from '../ui/components.js';
import { renderDashboard } from '../ui/dashboard.js';
import { renderGoodbye, renderPanel, renderQueueEnd, renderTrackProblem } from '../ui/panel.js';

const GONE = new Set([10003, 10008, 50001]); // Unknown Channel, Unknown Message, Missing Access
const CLAIM_TIMEOUT = 10_000;
const PROBLEM_NOTICE_TTL = 15_000;

/**
 * Keeps one live player message per server.
 *
 * - With `/setup`, the player is the dashboard message in the request channel: it is edited in
 *   place forever and falls back to an idle card when nothing is playing.
 * - Without `/setup`, a new song edits the player in place while it is still the newest message
 *   in the channel, otherwise the player moves to the bottom (new message, old one deleted), and
 *   `/play` can claim it so its own reply becomes the player instead of a second message.
 * - Changes are coalesced and every Discord call for a server runs in order.
 * - The player's location is stored in `player.data`, so it survives restarts with the player.
 */
export class Panels {
  #client;
  #raya;
  #log;
  #settings;
  #links;
  #songRequests;
  #options;
  #chains = new Map();
  #timers = new Map();
  #claims = new Map();
  #lastProblem = new Map();

  constructor({ client, raya, log, settings = null, links = () => ({}), songRequests = true, emptyLeaveDelay = 0, queueEndLeaveDelay = 0 }) {
    this.#client = client;
    this.#raya = raya;
    this.#log = log;
    this.#settings = settings;
    this.#links = links;
    this.#songRequests = songRequests;
    this.#options = { emptyLeaveDelay, queueEndLeaveDelay };
  }

  attach() {
    const raya = this.#raya;
    raya.on('trackStart', (player) => {
      player.data.delete('queueEndedAt');
      player.data.set('songs', (player.data.get('songs') ?? 0) + 1);
      if (!player.data.has('since')) player.data.set('since', Date.now());
      this.#task(player.guildId, () => this.#show(player, () => renderPanel(player, this.#options)));
    });
    raya.on('queueEnd', (player, lastTrack) => {
      player.data.set('queueEndedAt', Date.now());
      this.#task(player.guildId, () => this.#show(player, () => renderQueueEnd(player, lastTrack, this.#options)));
    });
    raya.on('playerDestroy', (player, reason) => {
      this.cancelRefresh(player);
      this.#claims.get(player.guildId)?.settle('destroyed');
      this.#task(player.guildId, () => this.#finish(player, reason));
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
    raya.on('trackError', (player, track, exception) => this.#task(player.guildId, () => this.#problem(player, track, exception?.message)));
    raya.on('trackStuck', (player, track) => this.#task(player.guildId, () => this.#problem(player, track, 'The song got stuck')));
    return this;
  }

  /** Render the player for this server (used by buttons and commands). */
  render(player) {
    return player.current
      ? renderPanel(player, this.#options)
      : renderQueueEnd(player, player.queue.previous ?? null, this.#options);
  }

  /** The song request dashboard of a server: the live player, or the idle card. */
  renderDashboardCard(guildId, player = this.#raya.getPlayer(guildId)) {
    return renderDashboard({
      player: player && !player.destroyed ? player : null,
      setup: this.#settings?.setup(guildId) ?? null,
      name: this.#client.user?.displayName ?? 'Raya',
      avatar: this.#client.user?.displayAvatarURL?.({ extension: 'png', size: 256 }) ?? null,
      djRoleId: this.#settings?.get(guildId)?.djRoleId ?? null,
      links: this.#links() ?? {},
      requests: this.#songRequests,
      listeners: this.#listeners(player),
    });
  }

  /** Use this message as the server's player from now on. */
  adopt(player, message) {
    this.#remember(player, message);
  }

  /**
   * Let an interaction's deferred reply become the next player message. `settled` resolves with
   * 'consumed' (the reply is now the player), 'failed' (the song couldn't start and the reply says so),
   * 'replaced' (a newer claim took over), 'destroyed' or 'expired'. Servers with a dashboard never
   * hand over the reply, because the player lives in the request channel.
   */
  claim(interaction) {
    const guildId = interaction.guildId;
    this.#claims.get(guildId)?.settle('replaced');
    if (this.#dashboard(guildId)) return { state: 'released', settled: Promise.resolve('released'), settle: () => false };

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

  /** Re-render the player after a short delay; calls within the delay are merged into one edit. */
  refresh(player, delay = 300) {
    const guildId = player.guildId;
    clearTimeout(this.#timers.get(guildId));
    const timer = setTimeout(() => {
      this.#timers.delete(guildId);
      this.#task(guildId, () => this.#update(player));
    }, delay);
    timer.unref?.();
    this.#timers.set(guildId, timer);
  }

  cancelRefresh(player) {
    clearTimeout(this.#timers.get(player.guildId));
    this.#timers.delete(player.guildId);
  }

  /** Post the player as a new message at the bottom of the channel (or as an interaction reply). */
  async repost(player, interaction) {
    const dashboard = this.#dashboard(player.guildId);
    if (dashboard) {
      await this.#editMessage(dashboard, this.renderDashboardCard(player.guildId, player));
      await interaction.reply(
        create(notice(`The player lives in <#${dashboard.channelId}>`, { note: 'It updates itself there.' }), { ephemeral: true }),
      );
      return;
    }
    const container = this.render(player);
    const previous = player.data.get('panel');
    const response = await interaction.reply({ ...create(container), withResponse: true });
    const message = response.resource?.message;
    if (!message) return;
    this.#remember(player, message);
    if (previous && previous.messageId !== message.id) await this.#delete(previous);
  }

  /**
   * Draw the idle dashboard of a server, creating the message when it is missing.
   * Returns the message id, or null when the channel is gone.
   */
  async refreshDashboard(guildId) {
    const setup = this.#settings?.setup(guildId);
    if (!setup?.textChannelId) return null;
    const container = this.renderDashboardCard(guildId);
    return this.#task(guildId, async () => {
      if (setup.messageId && (await this.#editMessage({ channelId: setup.textChannelId, messageId: setup.messageId }, container))) {
        return setup.messageId;
      }
      return this.#createDashboard(guildId, setup, container);
    });
  }

  // ==================== Internals ====================

  /** How many people (not bots) are in the player's voice channel, when we can tell. */
  #listeners(player) {
    const channel = player?.voiceChannelId ? this.#client.channels.cache.get(player.voiceChannelId) : null;
    if (!channel?.members) return null;
    return [...channel.members.values()].filter((member) => !member.user?.bot).length;
  }

  #dashboard(guildId) {
    const setup = this.#settings?.setup(guildId);
    return setup?.textChannelId && setup.messageId
      ? { channelId: setup.textChannelId, messageId: setup.messageId }
      : null;
  }

  async #createDashboard(guildId, setup, container) {
    const channel = this.#client.channels.cache.get(setup.textChannelId);
    if (!channel?.isSendable?.()) return null;
    const message = await channel.send(create(container)).catch((error) => {
      this.#log.warn(`[dashboard ${guildId}] could not post: ${error.message}`);
      return null;
    });
    if (!message) return null;
    this.#settings.update(guildId, { setup: { ...setup, messageId: message.id } });
    return message.id;
  }

  #task(guildId, fn) {
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

    const dashboard = this.#dashboard(player.guildId);
    if (dashboard) {
      const card = this.renderDashboardCard(player.guildId, player);
      if (await this.#editMessage(dashboard, card)) return;
      await this.#createDashboard(player.guildId, this.#settings.setup(player.guildId), card);
      return;
    }

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
      if (await this.#editMessage(previous, render(), player)) return;
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
    const dashboard = this.#dashboard(player.guildId);
    if (dashboard) {
      await this.#editMessage(dashboard, this.renderDashboardCard(player.guildId, player));
      return;
    }
    const panel = player.data.get('panel');
    if (panel) await this.#editMessage(panel, this.render(player), player);
  }

  async #finish(player, reason) {
    const dashboard = this.#dashboard(player.guildId);
    if (dashboard) {
      await this.#editMessage(dashboard, this.renderDashboardCard(player.guildId, null));
      return;
    }
    const panel = player.data.get('panel');
    if (panel) await this.#editMessage(panel, renderGoodbye(player, reason), player);
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

  /** Edit a message we own; returns false when it is gone. */
  async #editMessage(ref, container, player = null) {
    const channel = this.#client.channels.cache.get(ref.channelId);
    if (!channel?.messages) {
      player?.data.delete('panel');
      return false;
    }
    try {
      await channel.messages.edit(ref.messageId, edit(container));
      return true;
    } catch (error) {
      if (GONE.has(error.code)) {
        if (player?.data.get('panel')?.messageId === ref.messageId) player.data.delete('panel');
      } else {
        this.#log.debug(`[panel ${ref.channelId}] edit failed: ${error.message}`);
      }
      return false;
    }
  }

  async #delete(panel) {
    const channel = this.#client.channels.cache.get(panel.channelId);
    await channel?.messages?.delete(panel.messageId).catch(() => undefined);
  }
}
