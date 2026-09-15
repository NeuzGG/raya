/**
 * Exponential backoff utility for reconnection logic
 * Implements exponential delay with jitter to prevent thundering herd
 */

export interface BackoffOptions {
  /** Base delay in milliseconds */
  baseDelay: number;
  /** Maximum delay in milliseconds */
  maxDelay: number;
  /** Maximum number of attempts (0 = infinite) */
  maxAttempts: number;
  /** Jitter factor (0.0 - 1.0) */
  jitter: number;
}

export class ExponentialBackoff {
  private attempt: number = 0;
  private options: Required<BackoffOptions>;

  constructor(options: Partial<BackoffOptions> = {}) {
    this.options = {
      baseDelay: options.baseDelay ?? 1000,
      maxDelay: options.maxDelay ?? 60000,
      maxAttempts: options.maxAttempts ?? 0,
      jitter: options.jitter ?? 0.2,
    };
  }

  /**
   * Calculate the next delay with exponential backoff and jitter
   */
  next(): number {
    if (this.options.maxAttempts > 0 && this.attempt >= this.options.maxAttempts) {
      throw new Error('Maximum reconnection attempts reached');
    }

    // Calculate exponential delay: baseDelay * 2^attempt
    const exponentialDelay = this.options.baseDelay * Math.pow(2, this.attempt);

    // Cap at maxDelay
    const cappedDelay = Math.min(exponentialDelay, this.options.maxDelay);

    // Add jitter: random value between [delay * (1 - jitter), delay * (1 + jitter)]
    const jitterRange = cappedDelay * this.options.jitter;
    const jitterValue = Math.random() * jitterRange * 2 - jitterRange;
    const finalDelay = Math.max(0, cappedDelay + jitterValue);

    this.attempt++;
    return Math.floor(finalDelay);
  }

  /**
   * Get current attempt count
   */
  getAttempt(): number {
    return this.attempt;
  }

  /**
   * Reset the backoff state
   */
  reset(): void {
    this.attempt = 0;
  }

  /**
   * Check if max attempts reached
   */
  hasReachedMaxAttempts(): boolean {
    return this.options.maxAttempts > 0 && this.attempt >= this.options.maxAttempts;
  }

  /**
   * Get remaining attempts (-1 if infinite)
   */
  getRemainingAttempts(): number {
    if (this.options.maxAttempts === 0) {
      return -1;
    }
    return Math.max(0, this.options.maxAttempts - this.attempt);
  }
}

/**
 * Sleep utility for async delay
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with exponential backoff retry logic
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  options: Partial<BackoffOptions> = {}
): Promise<T> {
  const backoff = new ExponentialBackoff(options);
  let lastError: Error | undefined;

  while (!backoff.hasReachedMaxAttempts()) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (backoff.hasReachedMaxAttempts()) {
        throw lastError;
      }

      const delay = backoff.next();
      await sleep(delay);
    }
  }

  throw lastError ?? new Error('Backoff failed with unknown error');
}
