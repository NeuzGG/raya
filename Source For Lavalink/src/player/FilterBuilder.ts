/**
 * FilterBuilder - Fluent/chainable API for configuring Lavalink v4 filters
 * Provides an elegant developer experience for audio filter configuration
 */

import type {
  FilterOptions,
  EqualizerBand,
  KaraokeFilter,
  TimescaleFilter,
  TremoloFilter,
  VibratoFilter,
  RotationFilter,
  DistortionFilter,
  ChannelMixFilter,
  LowPassFilter,
} from '../types/lavalink';
import type { Player } from './Player';

/**
 * Preset equalizer configurations
 */
export const EqualizerPresets = {
  /** Boost bass frequencies */
  Bass: [
    { band: 0, gain: 0.6 },
    { band: 1, gain: 0.4 },
    { band: 2, gain: 0.2 },
  ] as EqualizerBand[],

  /** Boost treble frequencies */
  Treble: [
    { band: 12, gain: 0.2 },
    { band: 13, gain: 0.4 },
    { band: 14, gain: 0.6 },
  ] as EqualizerBand[],

  /** Soft sound profile */
  Soft: [
    { band: 0, gain: 0.25 },
    { band: 1, gain: 0.15 },
    { band: 2, gain: 0.1 },
    { band: 3, gain: -0.05 },
  ] as EqualizerBand[],

  /** Flat response (no equalization) */
  Flat: Array.from({ length: 15 }, (_, i) => ({ band: i, gain: 0 })) as EqualizerBand[],

  /** Electronic music profile */
  Electronic: [
    { band: 0, gain: 0.4 },
    { band: 1, gain: 0.3 },
    { band: 2, gain: 0.1 },
    { band: 8, gain: 0.2 },
    { band: 9, gain: 0.3 },
    { band: 10, gain: 0.4 },
  ] as EqualizerBand[],

  /** Rock music profile */
  Rock: [
    { band: 0, gain: 0.3 },
    { band: 1, gain: 0.25 },
    { band: 2, gain: 0.2 },
    { band: 3, gain: 0.1 },
    { band: 4, gain: 0.05 },
    { band: 5, gain: -0.05 },
    { band: 6, gain: -0.1 },
    { band: 7, gain: 0.1 },
    { band: 8, gain: 0.2 },
    { band: 9, gain: 0.3 },
  ] as EqualizerBand[],

  /** Classical music profile */
  Classical: [
    { band: 0, gain: 0.375 },
    { band: 1, gain: 0.35 },
    { band: 2, gain: 0.125 },
    { band: 3, gain: 0 },
    { band: 4, gain: 0 },
    { band: 5, gain: 0.125 },
    { band: 6, gain: 0.55 },
    { band: 7, gain: 0.05 },
    { band: 8, gain: 0.125 },
  ] as EqualizerBand[],

  /** Pop music profile */
  Pop: [
    { band: 0, gain: -0.02 },
    { band: 1, gain: -0.01 },
    { band: 2, gain: 0.08 },
    { band: 3, gain: 0.1 },
    { band: 4, gain: 0.15 },
    { band: 5, gain: 0.1 },
    { band: 6, gain: 0.03 },
    { band: 7, gain: -0.02 },
    { band: 8, gain: -0.035 },
    { band: 9, gain: -0.05 },
  ] as EqualizerBand[],
};

export class FilterBuilder {
  private filters: FilterOptions = {};
  private player: Player;

  constructor(player: Player) {
    this.player = player;
  }

  /**
   * Set volume (0.0 - 5.0)
   */
  public volume(volume: number): this {
    if (volume < 0 || volume > 5) {
      throw new Error('Volume must be between 0.0 and 5.0');
    }
    this.filters.volume = volume;
    return this;
  }

  /**
   * Set equalizer bands with validation
   * @param bands Array of equalizer bands (0-14, gain: -0.25 to 1.0)
   */
  public equalizer(bands: EqualizerBand[]): this {
    if (!Array.isArray(bands) || bands.length === 0) {
      throw new Error('Equalizer bands must be a non-empty array');
    }
    
    for (const band of bands) {
      if (typeof band.band !== 'number' || band.band < 0 || band.band > 14) {
        throw new Error(`Equalizer band must be between 0 and 14, got ${band.band}`);
      }
      if (typeof band.gain !== 'number' || band.gain < -0.25 || band.gain > 1.0) {
        throw new Error(`Equalizer gain must be between -0.25 and 1.0, got ${band.gain}`);
      }
    }
    this.filters.equalizer = bands;
    return this;
  }

  /**
   * Apply an equalizer preset
   */
  public equalizerPreset(preset: keyof typeof EqualizerPresets): this {
    this.filters.equalizer = EqualizerPresets[preset];
    return this;
  }

  /**
   * Enable karaoke effect
   */
  public karaoke(options?: KaraokeFilter): this {
    this.filters.karaoke = options || {
      level: 1.0,
      monoLevel: 1.0,
      filterBand: 220.0,
      filterWidth: 100.0,
    };
    return this;
  }

  /**
   * Set timescale (speed, pitch, rate)
   */
  public timescale(options: TimescaleFilter): this {
    if (options.speed !== undefined && options.speed <= 0) {
      throw new Error('Timescale speed must be greater than 0');
    }
    if (options.pitch !== undefined && options.pitch <= 0) {
      throw new Error('Timescale pitch must be greater than 0');
    }
    if (options.rate !== undefined && options.rate <= 0) {
      throw new Error('Timescale rate must be greater than 0');
    }
    this.filters.timescale = options;
    return this;
  }

  /**
   * Set tremolo effect with validation
   */
  public tremolo(options: TremoloFilter): this {
    if (typeof options.frequency !== 'number' || options.frequency <= 0) {
      throw new Error(`Tremolo frequency must be greater than 0, got ${options.frequency}`);
    }
    if (typeof options.depth !== 'number' || options.depth < 0 || options.depth > 1) {
      throw new Error(`Tremolo depth must be between 0.0 and 1.0, got ${options.depth}`);
    }
    this.filters.tremolo = options;
    return this;
  }

  /**
   * Set vibrato effect with validation
   */
  public vibrato(options: VibratoFilter): this {
    if (typeof options.frequency !== 'number' || options.frequency < 0 || options.frequency > 14) {
      throw new Error(`Vibrato frequency must be between 0.0 and 14.0, got ${options.frequency}`);
    }
    if (typeof options.depth !== 'number' || options.depth < 0 || options.depth > 1) {
      throw new Error(`Vibrato depth must be between 0.0 and 1.0, got ${options.depth}`);
    }
    this.filters.vibrato = options;
    return this;
  }

  /**
   * Set rotation effect (8D audio)
   */
  public rotation(options: RotationFilter): this {
    this.filters.rotation = options;
    return this;
  }

  /**
   * Set distortion effect
   */
  public distortion(options: DistortionFilter): this {
    this.filters.distortion = options;
    return this;
  }

  /**
   * Set channel mix (stereo manipulation)
   */
  public channelMix(options: ChannelMixFilter): this {
    this.filters.channelMix = options;
    return this;
  }

  /**
   * Set low pass filter
   */
  public lowPass(options: LowPassFilter): this {
    this.filters.lowPass = options;
    return this;
  }

  /**
   * Nightcore effect (speed up + pitch up)
   */
  public nightcore(speed: number = 1.3): this {
    this.filters.timescale = {
      speed,
      pitch: speed,
      rate: 1.0,
    };
    this.filters.equalizer = [
      { band: 1, gain: 0.3 },
      { band: 0, gain: 0.3 },
    ];
    return this;
  }

  /**
   * Vaporwave effect (slow down + pitch down)
   */
  public vaporwave(speed: number = 0.8): this {
    this.filters.timescale = {
      speed,
      pitch: speed,
      rate: 1.0,
    };
    this.filters.equalizer = [
      { band: 1, gain: 0.3 },
      { band: 0, gain: 0.3 },
    ];
    this.filters.tremolo = {
      frequency: 4.0,
      depth: 0.5,
    };
    return this;
  }

  /**
   * 8D audio effect
   */
  public eightD(rotationHz: number = 0.2): this {
    this.filters.rotation = { rotationHz };
    return this;
  }

  /**
   * Bass boost effect
   */
  public bassboost(level: 'low' | 'medium' | 'high' | 'extreme' = 'medium'): this {
    const levels = {
      low: 0.2,
      medium: 0.4,
      high: 0.6,
      extreme: 1.0,
    };

    const gain = levels[level];
    this.filters.equalizer = [
      { band: 0, gain },
      { band: 1, gain: gain * 0.8 },
      { band: 2, gain: gain * 0.6 },
      { band: 3, gain: gain * 0.4 },
      { band: 4, gain: gain * 0.2 },
    ];
    return this;
  }

  /**
   * Soft audio effect
   */
  public soft(): this {
    this.filters.lowPass = { smoothing: 20 };
    return this;
  }

  /**
   * Clear all filters
   */
  public clear(): this {
    this.filters = {};
    return this;
  }

  /**
   * Clear a specific filter
   */
  public clearFilter(filter: keyof FilterOptions): this {
    delete this.filters[filter];
    return this;
  }

  /**
   * Get current filter configuration
   */
  public getFilters(): FilterOptions {
    return { ...this.filters };
  }

  /**
   * Set filters from a configuration object
   */
  public setFilters(filters: FilterOptions): this {
    this.filters = { ...filters };
    return this;
  }

  /**
   * Merge with existing filters
   */
  public mergeFilters(filters: Partial<FilterOptions>): this {
    this.filters = { ...this.filters, ...filters };
    return this;
  }

  /**
   * Apply the configured filters to the player
   */
  public async apply(): Promise<void> {
    await this.player.setFilters(this.filters);
  }

  /**
   * Create a copy of this filter builder
   */
  public clone(): FilterBuilder {
    const cloned = new FilterBuilder(this.player);
    cloned.filters = { ...this.filters };
    return cloned;
  }
}
