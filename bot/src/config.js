import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Load `bot/.env` into process.env (variables that are already set win). */
export function loadEnvFile(file = path.join(BOT_ROOT, '.env')) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

function text(env, name, fallback = null) {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function integer(env, name, fallback, min, max) {
  const raw = text(env, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return value;
}

function bool(env, name, fallback) {
  const raw = text(env, name);
  if (raw === null) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new ConfigError(`${name} must be true or false, got "${raw}"`);
}

function url(env, name, fallback) {
  const raw = text(env, name, fallback);
  if (raw === null) return null;
  if (!/^https?:\/\//i.test(raw)) throw new ConfigError(`${name} must start with http:// or https://, got "${raw}"`);
  return raw;
}

function nodes(env) {
  const json = text(env, 'LAVALINK_NODES');
  if (json) {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new ConfigError('LAVALINK_NODES must be a JSON array, e.g. [{"name":"main","host":"localhost","port":2333,"password":"youshallnotpass"}]');
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((node) => !node?.host || !node?.password)) {
      throw new ConfigError('LAVALINK_NODES must be a non-empty array of nodes with at least "host" and "password"');
    }
    return parsed;
  }
  return [
    {
      name: text(env, 'LAVALINK_NAME', 'main'),
      host: text(env, 'LAVALINK_HOST', 'localhost'),
      port: integer(env, 'LAVALINK_PORT', 2333, 1, 65535),
      password: text(env, 'LAVALINK_PASSWORD', 'youshallnotpass'),
      secure: bool(env, 'LAVALINK_SECURE', false),
    },
  ];
}

/**
 * Read the bot configuration from environment variables.
 * Secrets only ever come from the environment (bot/.env locally), never from files in the repo.
 */
export function loadConfig(env = process.env) {
  const token = text(env, 'DISCORD_TOKEN');
  if (!token) throw new ConfigError('DISCORD_TOKEN is missing. Copy bot/.env.example to bot/.env and add your bot token.');

  return {
    token,
    devGuildId: text(env, 'DEV_GUILD_ID'),
    nodes: nodes(env),
    searchSource: text(env, 'SEARCH_SOURCE', 'youtube'),
    player: {
      volume: integer(env, 'DEFAULT_VOLUME', 80, 1, 200),
      maxVolume: 200,
      leaveWhenEmptyAfter: integer(env, 'LEAVE_WHEN_EMPTY_AFTER', 60, 0, 86400) * 1000,
      leaveAfterQueueEnd: integer(env, 'LEAVE_AFTER_QUEUE_END', 180, 0, 86400) * 1000,
      maxQueueSize: integer(env, 'MAX_QUEUE_SIZE', 1000, 1, 10000),
    },
    voiceStatus: bool(env, 'VOICE_STATUS', true),
    links: {
      website: url(env, 'WEBSITE_URL', 'https://neuzgg.github.io/raya/'),
      github: url(env, 'GITHUB_URL', 'https://github.com/neuzgg/raya'),
      support: url(env, 'SUPPORT_URL', null),
    },
    snapshotFile: path.resolve(BOT_ROOT, text(env, 'SNAPSHOT_FILE', 'data/snapshot.json')),
    debug: bool(env, 'RAYA_DEBUG', false),
  };
}
