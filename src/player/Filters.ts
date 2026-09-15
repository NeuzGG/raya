import type { Player } from './Player';
import type {
  ChannelMixFilter,
  DistortionFilter,
  EqualizerBand,
  FilterOptions,
  KaraokeFilter,
  LowPassFilter,
  RotationFilter,
  TimescaleFilter,
  TremoloFilter,
  VibratoFilter,
} from '../types/lavalink';
import { RayaError } from '../utils/errors';

const BAND_COUNT = 15;

export const EqualizerPresets = {
  flat: Array.from({ length: BAND_COUNT }, () => 0),
  bass: [0.2, 0.15, 0.1, 0.05, 0, -0.05, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1],
  pop: [-0.02, -0.01, 0.08, 0.1, 0.15, 0.1, 0.03, -0.02, -0.035, -0.05, -0.05, -0.05, -0.05, -0.05, -0.05],
  rock: [0.3, 0.25, 0.2, 0.1, 0.05, -0.05, -0.15, -0.2, -0.1, -0.05, 0.05, 0.1, 0.2, 0.25, 0.3],
  electronic: [0.375, 0.35, 0.125, 0, 0, -0.125, -0.125, 0, 0.25, 0.125, 0.15, 0.2, 0.25, 0.35, 0.4],
  classical: [0.375, 0.35, 0.125, 0, 0, 0.125, 0.55, 0.05, 0.125, 0.25, 0.2, 0.25, 0.3, 0.25, 0.3],
  soft: [0, 0, 0, 0, 0, 0, 0, 0, -0.25, -0.25, -0.25, -0.25, -0.25, -0.25, -0.25],
  treble: [-0.1, -0.1, -0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5],
  vocal: [-0.2, -0.15, -0.1, 0, 0.15, 0.25, 0.3, 0.3, 0.25, 0.15, 0, -0.05, -0.1, -0.1, -0.1],
} as const satisfies Record<string, readonly number[]>;

export type EqualizerPreset = keyof typeof EqualizerPresets;

export type BassBoostLevel = 'off' | 'low' | 'medium' | 'high' | 'extreme';

const BASS_LEVELS: Record<BassBoostLevel, number> = { off: 0, low: 0.1, medium: 0.2, high: 0.35, extreme: 0.6 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Player audio filters. Each setter applies immediately; setters called in the same tick
 * are merged into a single Lavalink request.
 */
export class Filters {
  private state: FilterOptions = {};
  private bands: number[] = Array.from({ length: BAND_COUNT }, () => 0);

  constructor(private readonly player: Player) {}

  /** Current filter payload */
  public get value(): Readonly<FilterOptions> {
    return this.state;
  }

  /** Names of active filters */
  public get active(): string[] {
    const names = Object.keys(this.state).filter((k) => k !== 'pluginFilters');
    if (this.state.pluginFilters) names.push(...Object.keys(this.state.pluginFilters));
    return names;
  }

  /** Effective playback speed multiplier from the timescale filter */
  public get speedMultiplier(): number {
    const t = this.state.timescale;
    return (t?.speed ?? 1) * (t?.rate ?? 1);
  }

  // ==================== Bulk ====================

  /** Replace all filters. */
  public set(filters: FilterOptions): Promise<void> {
    this._load(filters);
    return this.commit();
  }

  /** Merge filters into the current ones. `null` removes a filter. */
  public patch(filters: FilterOptions): Promise<void> {
    const next: Record<string, unknown> = { ...this.state };
    for (const [key, value] of Object.entries(filters)) {
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
    }
    this._load(next as FilterOptions);
    return this.commit();
  }

  /** Remove every filter. */
  public clear(): Promise<void> {
    this._load({});
    return this.commit();
  }

  // ==================== Core filters ====================

  /** Filter volume multiplier, 0 - 5 (1 = 100%). */
  public setVolume(volume: number): Promise<void> {
    this.assertNumber(volume, 'volume');
    const v = clamp(volume, 0, 5);
    if (v === 1) delete this.state.volume;
    else this.state.volume = v;
    return this.commit();
  }

  /** Set equalizer bands (merged with existing bands). Gains are clamped to -0.25 - 1. */
  public setEqualizer(bands: EqualizerBand[]): Promise<void> {
    for (const { band, gain } of bands) {
      if (!Number.isInteger(band) || band < 0 || band >= BAND_COUNT) {
        throw new RayaError('INVALID_ARGUMENT', `Equalizer band must be 0-14, got ${band}`);
      }
      this.assertNumber(gain, 'gain');
      this.bands[band] = clamp(gain, -0.25, 1);
    }
    this.syncEqualizer();
    return this.commit();
  }

  public setEqualizerPreset(preset: EqualizerPreset): Promise<void> {
    const gains = EqualizerPresets[preset];
    if (!gains) throw new RayaError('INVALID_ARGUMENT', `Unknown equalizer preset "${preset}"`);
    this.bands = [...gains];
    this.syncEqualizer();
    return this.commit();
  }

  public clearEqualizer(): Promise<void> {
    this.bands.fill(0);
    this.syncEqualizer();
    return this.commit();
  }

  public setTimescale(timescale: TimescaleFilter | null): Promise<void> {
    if (timescale) {
      for (const key of ['speed', 'pitch', 'rate'] as const) {
        const v = timescale[key];
        if (v !== undefined && (!Number.isFinite(v) || v <= 0)) {
          throw new RayaError('INVALID_ARGUMENT', `Timescale ${key} must be greater than 0`);
        }
      }
    }
    return this.setOrRemove('timescale', timescale);
  }

  public setKaraoke(karaoke: KaraokeFilter | null): Promise<void> {
    return this.setOrRemove('karaoke', karaoke);
  }

  public setTremolo(tremolo: TremoloFilter | null): Promise<void> {
    return this.setOrRemove('tremolo', tremolo);
  }

  public setVibrato(vibrato: VibratoFilter | null): Promise<void> {
    return this.setOrRemove('vibrato', vibrato);
  }

  public setRotation(rotation: RotationFilter | null): Promise<void> {
    return this.setOrRemove('rotation', rotation);
  }

  public setDistortion(distortion: DistortionFilter | null): Promise<void> {
    return this.setOrRemove('distortion', distortion);
  }

  public setChannelMix(channelMix: ChannelMixFilter | null): Promise<void> {
    return this.setOrRemove('channelMix', channelMix);
  }

  public setLowPass(lowPass: LowPassFilter | null): Promise<void> {
    return this.setOrRemove('lowPass', lowPass);
  }

  /** Set a Lavalink plugin filter (e.g. LavaDSPX `echo`), or null to remove it. */
  public setPluginFilter(name: string, value: unknown): Promise<void> {
    const plugins = { ...(this.state.pluginFilters ?? {}) };
    if (value === null || value === undefined) delete plugins[name];
    else plugins[name] = value;
    if (Object.keys(plugins).length) this.state.pluginFilters = plugins;
    else delete this.state.pluginFilters;
    return this.commit();
  }

  // ==================== Presets ====================

  public setSpeed(speed: number): Promise<void> {
    return this.setTimescale({ ...(this.state.timescale ?? {}), speed });
  }

  public setPitch(pitch: number): Promise<void> {
    return this.setTimescale({ ...(this.state.timescale ?? {}), pitch });
  }

  public setRate(rate: number): Promise<void> {
    return this.setTimescale({ ...(this.state.timescale ?? {}), rate });
  }

  /** Boost low frequencies. Only touches bands 0-4, so it combines with other EQ settings. */
  public bassBoost(level: BassBoostLevel | number = 'medium'): Promise<void> {
    const gain = typeof level === 'number' ? clamp(level, 0, 1) : BASS_LEVELS[level];
    if (gain === undefined) throw new RayaError('INVALID_ARGUMENT', `Unknown bass boost level "${level}"`);
    const shape = [1, 0.85, 0.65, 0.4, 0.15];
    shape.forEach((factor, band) => {
      this.bands[band] = clamp(gain * factor, -0.25, 1);
    });
    this.syncEqualizer();
    return this.commit();
  }

  public nightcore(enabled = true): Promise<void> {
    return this.setTimescale(enabled ? { speed: 1.1, pitch: 1.125, rate: 1.05 } : null);
  }

  public vaporwave(enabled = true): Promise<void> {
    return this.setTimescale(enabled ? { speed: 0.85, pitch: 0.8, rate: 1 } : null);
  }

  /** Audio rotating around the listener (best with headphones). */
  public eightD(enabled = true, rotationHz = 0.2): Promise<void> {
    return this.setRotation(enabled ? { rotationHz } : null);
  }

  public karaoke(enabled = true): Promise<void> {
    return this.setKaraoke(enabled ? { level: 1, monoLevel: 1, filterBand: 220, filterWidth: 100 } : null);
  }

  public soft(enabled = true): Promise<void> {
    return this.setLowPass(enabled ? { smoothing: 20 } : null);
  }

  public tremolo(enabled = true, frequency = 4, depth = 0.75): Promise<void> {
    return this.setTremolo(enabled ? { frequency, depth } : null);
  }

  public vibrato(enabled = true, frequency = 4, depth = 0.75): Promise<void> {
    return this.setVibrato(enabled ? { frequency, depth } : null);
  }

  // ==================== Internals ====================

  /** @internal Load state without sending it (restore / resync). */
  public _load(filters: FilterOptions): void {
    const next: FilterOptions = {};
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value === null || value === undefined) continue;
      if (key === 'equalizer' || key === 'pluginFilters') continue;
      (next as Record<string, unknown>)[key] = value;
    }
    if (next.volume === 1) delete next.volume;
    this.bands.fill(0);
    for (const { band, gain } of filters?.equalizer ?? []) {
      if (band >= 0 && band < BAND_COUNT) this.bands[band] = clamp(gain, -0.25, 1);
    }
    if (filters?.pluginFilters && Object.keys(filters.pluginFilters).length) {
      next.pluginFilters = { ...filters.pluginFilters };
    }
    this.state = next;
    this.syncEqualizer();
  }

  /** @internal */
  public _payload(): FilterOptions {
    return JSON.parse(JSON.stringify(this.state)) as FilterOptions;
  }

  private setOrRemove<K extends keyof FilterOptions>(key: K, value: FilterOptions[K] | null): Promise<void> {
    if (value === null || value === undefined) delete this.state[key];
    else this.state[key] = value;
    return this.commit();
  }

  private syncEqualizer(): void {
    const bands = this.bands.map((gain, band) => ({ band, gain })).filter((b) => b.gain !== 0);
    if (bands.length) this.state.equalizer = bands;
    else delete this.state.equalizer;
  }

  private assertNumber(value: number, name: string): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RayaError('INVALID_ARGUMENT', `Filter ${name} must be a finite number`);
    }
  }

  private async commit(): Promise<void> {
    await this.player._update({ filters: this._payload() });
  }
}
