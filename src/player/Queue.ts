import type { Player } from './Player';
import type { Track } from '../types/raya';
import { RayaError } from '../utils/errors';

/**
 * Upcoming tracks plus a bounded history of played tracks.
 * Every mutation emits `queueUpdate`.
 */
export class Queue implements Iterable<Track> {
  private items: Track[] = [];
  private played: Track[] = [];

  constructor(
    private readonly player: Player,
    public maxSize: number,
    public historySize: number,
  ) {}

  // ==================== Reading ====================

  public get size(): number {
    return this.items.length;
  }

  public get length(): number {
    return this.items.length;
  }

  public get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** The next track to play */
  public get next(): Track | undefined {
    return this.items[0];
  }

  /** Total length of upcoming non-stream tracks in ms */
  public get duration(): number {
    let total = 0;
    for (const track of this.items) if (!track.info.isStream) total += track.info.length;
    return total;
  }

  /** Played tracks, most recent last */
  public get history(): readonly Track[] {
    return this.played;
  }

  /** The most recently played track */
  public get previous(): Track | undefined {
    return this.played[this.played.length - 1];
  }

  public at(index: number): Track | undefined {
    return this.items.at(index);
  }

  public slice(start?: number, end?: number): Track[] {
    return this.items.slice(start, end);
  }

  public find(predicate: (track: Track, index: number) => boolean): Track | undefined {
    return this.items.find(predicate);
  }

  public indexOf(track: Track): number {
    return this.items.indexOf(track);
  }

  public toArray(): Track[] {
    return [...this.items];
  }

  public [Symbol.iterator](): Iterator<Track> {
    return this.items[Symbol.iterator]();
  }

  // ==================== Writing ====================

  /**
   * Add one or more tracks, optionally at an index. Tracks beyond `maxSize` are dropped.
   * @returns the number of tracks added
   */
  public add(tracks: Track | readonly Track[], index?: number): number {
    const list = Array.isArray(tracks) ? (tracks as Track[]) : [tracks as Track];
    const room = Math.max(0, this.maxSize - this.items.length);
    const accepted = list.length > room ? list.slice(0, room) : list;
    if (accepted.length === 0) {
      if (list.length > 0) throw new RayaError('QUEUE_FULL', `Queue is full (max ${this.maxSize} tracks)`);
      return 0;
    }
    for (const track of accepted) this.assertTrack(track);

    if (index === undefined || index >= this.items.length) {
      for (const track of accepted) this.items.push(track);
    } else {
      this.items.splice(Math.max(0, index), 0, ...accepted);
    }
    this.changed();
    return accepted.length;
  }

  /** Add tracks to the front so they play next. */
  public addNext(tracks: Track | readonly Track[]): number {
    return this.add(tracks, 0);
  }

  public remove(index: number): Track | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) return undefined;
    const [removed] = this.items.splice(index, 1);
    this.changed();
    return removed;
  }

  /** Remove tracks in [start, end). */
  public removeRange(start: number, end: number): Track[] {
    const removed = this.items.splice(Math.max(0, start), Math.max(0, end - Math.max(0, start)));
    if (removed.length) this.changed();
    return removed;
  }

  /** Remove every track matching the predicate, e.g. all tracks from one requester. */
  public removeWhere(predicate: (track: Track, index: number) => boolean): Track[] {
    const removed: Track[] = [];
    const kept: Track[] = [];
    this.items.forEach((track, i) => (predicate(track, i) ? removed : kept).push(track));
    if (removed.length) {
      this.items = kept;
      this.changed();
    }
    return removed;
  }

  public move(from: number, to: number): boolean {
    const n = this.items.length;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= n || to >= n) return false;
    if (from !== to) {
      const [track] = this.items.splice(from, 1);
      this.items.splice(to, 0, track!);
      this.changed();
    }
    return true;
  }

  public swap(a: number, b: number): boolean {
    const n = this.items.length;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= n || b >= n) return false;
    if (a !== b) {
      [this.items[a], this.items[b]] = [this.items[b]!, this.items[a]!];
      this.changed();
    }
    return true;
  }

  /** Fisher-Yates shuffle */
  public shuffle(): void {
    for (let i = this.items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.items[i], this.items[j]] = [this.items[j]!, this.items[i]!];
    }
    if (this.items.length > 1) this.changed();
  }

  /** Remove duplicate tracks (same source + identifier), keeping the first occurrence. */
  public dedupe(): number {
    const seen = new Set<string>();
    const before = this.items.length;
    this.items = this.items.filter((track) => {
      const key = `${track.info.sourceName}:${track.info.identifier}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const removed = before - this.items.length;
    if (removed) this.changed();
    return removed;
  }

  public clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.changed();
  }

  public clearHistory(): void {
    this.played = [];
  }

  /** Take the next track off the queue. */
  public shift(): Track | undefined {
    const track = this.items.shift();
    if (track) this.changed();
    return track;
  }

  /** @internal */
  public _pushHistory(track: Track): void {
    if (this.historySize <= 0) return;
    this.played.push(track);
    if (this.played.length > this.historySize) this.played.splice(0, this.played.length - this.historySize);
  }

  /** @internal */
  public _popHistory(): Track | undefined {
    return this.played.pop();
  }

  /** @internal Bypasses maxSize, used by loop mode and snapshot restore. */
  public _restore(items: Track[], history: Track[]): void {
    this.items = [...items];
    this.played = history.slice(-this.historySize);
  }

  /** @internal */
  public _append(track: Track): void {
    this.items.push(track);
    this.changed();
  }

  private assertTrack(track: Track): void {
    if (!track || typeof track.encoded !== 'string' || !track.info) {
      throw new RayaError('INVALID_ARGUMENT', 'Queue only accepts Lavalink tracks (use search() results)');
    }
  }

  private changed(): void {
    this.player.raya.emit('queueUpdate', this.player, this);
  }
}
