import type { Raya } from '../Raya';
import type { DiscordVoiceStateUpdatePayload } from '../types/lavalink';
import type { Connector } from '../types/raya';

/* Minimal structural types so Raya does not depend on any Discord library. */

interface Emitter {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface RawPacket {
  t?: string | null;
  d?: any;
}

function attachRaw(raya: Raya, client: Emitter, event: string, getUserId: () => string | undefined): void {
  client.on(event, (packet: RawPacket) => {
    raya.handleRaw(packet);
    if (packet?.t === 'READY' && packet.d?.user?.id) {
      raya.init(packet.d.user.id).catch((error) => raya.debug(() => `init failed: ${String(error)}`));
    }
  });
  const userId = getUserId();
  if (userId) raya.init(userId).catch((error) => raya.debug(() => `init failed: ${String(error)}`));
}

const shardFor = (guildId: string, shardCount: number) => Number((BigInt(guildId) >> 22n) % BigInt(Math.max(1, shardCount)));

// ==================== discord.js ====================

export interface DiscordJSClientLike extends Emitter {
  user?: { id: string } | null;
  token?: string | null;
  guilds: { cache: { get(id: string): { shard?: { send(payload: unknown): unknown } } | undefined } };
  ws?: { shards?: { get(id: number): { send(payload: unknown): unknown } | undefined; size?: number } };
  options?: { shardCount?: number | 'auto' };
}

/** discord.js v14+ */
export class DiscordJSConnector implements Connector {
  constructor(public readonly client: DiscordJSClientLike) {}

  public attach(raya: Raya): void {
    attachRaw(raya, this.client, 'raw', () => this.client.user?.id);
  }

  public getToken(): string | null {
    return this.client.token ?? null;
  }

  public send(guildId: string, payload: DiscordVoiceStateUpdatePayload): void {
    const guild = this.client.guilds.cache.get(guildId);
    if (guild?.shard) {
      guild.shard.send(payload);
      return;
    }
    const count = typeof this.client.options?.shardCount === 'number' ? this.client.options.shardCount : 1;
    this.client.ws?.shards?.get(shardFor(guildId, count))?.send(payload);
  }
}

// ==================== Eris ====================

export interface ErisClientLike extends Emitter {
  user?: { id: string };
  token?: string;
  guildShardMap: Record<string, number>;
  shards: { get(id: number): { sendWS(op: number, data: unknown): unknown } | undefined };
}

export class ErisConnector implements Connector {
  constructor(public readonly client: ErisClientLike) {}

  public attach(raya: Raya): void {
    attachRaw(raya, this.client, 'rawWS', () => this.client.user?.id);
  }

  public getToken(): string | null {
    return this.client.token ?? null;
  }

  public send(guildId: string, payload: DiscordVoiceStateUpdatePayload): void {
    const shardId = this.client.guildShardMap[guildId] ?? 0;
    this.client.shards.get(shardId)?.sendWS(payload.op, payload.d);
  }
}

// ==================== OceanicJS ====================

export interface OceanicClientLike extends Emitter {
  user?: { id: string };
  options?: { auth?: string | null };
  guilds: { get(id: string): { shard: { send(op: number, data: unknown): unknown } } | undefined };
}

export class OceanicConnector implements Connector {
  constructor(public readonly client: OceanicClientLike) {}

  public attach(raya: Raya): void {
    attachRaw(raya, this.client, 'packet', () => this.client.user?.id);
  }

  public getToken(): string | null {
    return this.client.options?.auth ?? null;
  }

  public send(guildId: string, payload: DiscordVoiceStateUpdatePayload): void {
    this.client.guilds.get(guildId)?.shard.send(payload.op, payload.d);
  }
}

export const Connectors = {
  DiscordJS: DiscordJSConnector,
  Eris: ErisConnector,
  Oceanic: OceanicConnector,
} as const;
