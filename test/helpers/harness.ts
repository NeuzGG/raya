import { Raya } from '../../src/Raya';
import type { DiscordVoiceStateUpdatePayload } from '../../src/types/lavalink';
import type { RayaEvents, RayaOptions } from '../../src/types/raya';
import type { MockLavalink } from './MockLavalink';

export const BOT_ID = '100000000000000001';
export const GUILD_ID = '200000000000000002';
export const VOICE_ID = '300000000000000003';
export const OTHER_VOICE_ID = '300000000000000004';
export const USER_ID = '400000000000000004';

export interface Harness {
  raya: Raya;
  gateway: Array<{ guildId: string; payload: DiscordVoiceStateUpdatePayload; at: number }>;
  /** Whether the fake Discord answers opcode 4 with voice events */
  autoVoice: { enabled: boolean };
}

/**
 * A Raya instance wired to a fake Discord gateway that answers opcode 4 the way Discord does:
 * VOICE_STATE_UPDATE followed by VOICE_SERVER_UPDATE.
 */
export function createHarness(mocks: MockLavalink[], options: Partial<RayaOptions> = {}): Harness {
  const gateway: Harness['gateway'] = [];
  const autoVoice = { enabled: true };
  let voiceSession = 0;
  let raya!: Raya;

  const send = (guildId: string, payload: DiscordVoiceStateUpdatePayload) => {
    gateway.push({ guildId, payload, at: performance.now() });
    if (!autoVoice.enabled) return;
    setImmediate(() => {
      const channel = payload.d.channel_id;
      raya.handleRaw({
        t: 'VOICE_STATE_UPDATE',
        d: { guild_id: guildId, user_id: BOT_ID, session_id: `voice-session-${++voiceSession}`, channel_id: channel, member: { user: { id: BOT_ID, bot: true } } },
      });
      if (channel) {
        raya.handleRaw({
          t: 'VOICE_SERVER_UPDATE',
          d: { guild_id: guildId, token: `token-${voiceSession}`, endpoint: 'c-ams01-abcdef.discord.media:443' },
        });
      }
    });
  };

  raya = new Raya({
    send,
    ...options,
    nodes:
      options.nodes ??
      mocks.map((mock, i) => ({
        name: `node${i + 1}`,
        host: '127.0.0.1',
        port: mock.port,
        password: mock.password,
        retry: { baseDelay: 30, maxDelay: 120 },
        requestTimeout: 2000,
      })),
  });
  return { raya, gateway, autoVoice };
}

export async function waitFor<T>(check: () => T | undefined | null | false, timeout = 3000, label = 'condition'): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function nextEvent(emitter: Raya, event: keyof RayaEvents & string, timeout = 3000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for event ${event}`)), timeout);
    (emitter as any).once(event, (...args: any[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
