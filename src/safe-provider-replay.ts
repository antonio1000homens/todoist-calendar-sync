/**
 * Explicitly marks a failure whose provider writes use deterministic IDs and
 * can therefore be replayed safely. This is intentionally narrow: ordinary
 * partial provider writes remain quarantined.
 */
export class SafeProviderReplayError extends Error {
  readonly safeProviderReplay = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SafeProviderReplayError";
  }
}

export function isSafeProviderReplay(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    const fields = current as { safeProviderReplay?: unknown; cause?: unknown };
    if (fields.safeProviderReplay === true) return true;
    current = fields.cause;
  }
  return false;
}
