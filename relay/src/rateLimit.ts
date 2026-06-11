// Per-IP connection rate-limiting for the relay (#473).
//
// This module is opt-in: when the RATE_LIMIT_KV binding is absent (the default
// zero-binding BYO deploy), checkRateLimit always returns { allowed: true }.
// The existing controls — high-entropy room ids, capacity cap, idle + absolute TTL,
// frame-size cap (#197) — cover the single-user BYO case without any added binding.
// Enable rate-limiting for multi-tenant / public relays by wiring up the KV namespace
// (see wrangler.toml for instructions).

export interface RateLimitConfig {
  /** Max connection attempts allowed per IP within one window. */
  maxConnections: number;
  /** Window size in seconds. */
  windowSeconds: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxConnections: 20,
  windowSeconds: 60,
};

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining attempts in the current window (maxConnections when no binding). */
  remaining: number;
  /** Unix seconds when the current window resets (0 when no binding). */
  resetAt: number;
}

interface WindowEntry {
  count: number;
  windowStart: number; // unix seconds
}

/**
 * Check and increment the per-IP rate limit using Workers KV.
 *
 * When `kv` is `undefined` (binding absent — the default BYO deploy) this is a
 * pure no-op: it returns `{ allowed: true }` without any async I/O. This keeps
 * the zero-binding path fully open with no performance cost.
 *
 * Fixed-window semantics: a new window opens the first time an IP is seen, or
 * after the previous window has expired. The counter is always written (even on
 * rejection) so a sustained burst can't slip through on a window boundary.
 */
export async function checkRateLimit(
  kv: KVNamespace | undefined,
  ip: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT,
): Promise<RateLimitResult> {
  if (!kv) {
    return { allowed: true, remaining: config.maxConnections, resetAt: 0 };
  }

  const now = Math.floor(Date.now() / 1000);
  const key = `rl:${ip}`;

  const existing = await kv.get<WindowEntry>(key, "json");

  let entry: WindowEntry;
  if (!existing || now - existing.windowStart >= config.windowSeconds) {
    // Expired window or first visit — start a fresh window.
    entry = { count: 1, windowStart: now };
  } else {
    entry = { count: existing.count + 1, windowStart: existing.windowStart };
  }

  const resetAt = entry.windowStart + config.windowSeconds;
  const remaining = Math.max(0, config.maxConnections - entry.count);
  const allowed = entry.count <= config.maxConnections;

  // Always persist (even on rejection) so the counter keeps climbing during a burst.
  await kv.put(key, JSON.stringify(entry), {
    expiration: resetAt + config.windowSeconds,
  });

  return { allowed, remaining, resetAt };
}
