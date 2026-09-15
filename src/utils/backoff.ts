/**
 * Exponential backoff with "full jitter" (AWS architecture blog), which spreads
 * reconnect storms far better than +/- percentage jitter.
 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  // Never go below half the ceiling so reconnects don't hammer a dead node.
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
