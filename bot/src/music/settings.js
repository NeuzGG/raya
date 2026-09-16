import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-server settings: the `/setup` channels and the DJ role. One small JSON file, written
 * atomically and debounced, so a crash can never leave half a file behind.
 *
 * ```json
 * { "<guild id>": { "setup": { "categoryId": "...", "textChannelId": "...", "voiceChannelId": "...", "messageId": "..." }, "djRoleId": "..." } }
 * ```
 */
export class Settings {
  #file;
  #data;
  #timer = null;

  constructor(file) {
    this.#file = file;
    this.#data = Settings.#read(file);
  }

  static #read(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Settings for a server; always an object. */
  get(guildId) {
    return this.#data[guildId] ?? {};
  }

  /** The `/setup` channels of a server, or null. */
  setup(guildId) {
    return this.#data[guildId]?.setup ?? null;
  }

  /** Merge values into a server's settings. `null` removes a key. */
  update(guildId, patch) {
    const next = { ...this.get(guildId), ...patch };
    for (const [key, value] of Object.entries(next)) if (value === null || value === undefined) delete next[key];
    if (Object.keys(next).length === 0) delete this.#data[guildId];
    else this.#data[guildId] = next;
    this.#save();
    return next;
  }

  #save() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, 500);
    this.#timer.unref?.();
  }

  /** Write to disk now. */
  flush() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const temporary = `${this.#file}.tmp`;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(this.#data, null, 2));
    fs.renameSync(temporary, this.#file);
  }
}

/** A settings store that keeps everything in memory (used by the tests). */
export class MemorySettings extends Settings {
  constructor() {
    super('');
  }

  flush() {
    /* nothing to write */
  }
}
