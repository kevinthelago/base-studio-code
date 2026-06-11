import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, DEFAULT_RATE_LIMIT, type RateLimitConfig } from "../src/rateLimit";

// Minimal KV stub: only the get/put overloads used by checkRateLimit.
function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string, typeOrOptions?: unknown): Promise<unknown> {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return typeOrOptions === "json" ? (JSON.parse(raw) as unknown) : raw;
    },
    async put(key: string, value: string, _opts?: unknown): Promise<void> {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

const cfg: RateLimitConfig = { maxConnections: 3, windowSeconds: 60 };

describe("checkRateLimit — no binding (default BYO deploy)", () => {
  it("always allows and returns remaining = maxConnections", async () => {
    const r = await checkRateLimit(undefined, "1.2.3.4");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(DEFAULT_RATE_LIMIT.maxConnections);
    expect(r.resetAt).toBe(0);
  });

  it("allows every call without any async I/O", async () => {
    for (let i = 0; i < 100; i++) {
      const r = await checkRateLimit(undefined, "1.2.3.4");
      expect(r.allowed).toBe(true);
    }
  });
});

describe("checkRateLimit — with KV binding", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = makeKV();
  });

  it("allows the first connection and reports remaining = limit - 1", async () => {
    const r = await checkRateLimit(kv, "1.2.3.4", cfg);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(cfg.maxConnections - 1);
    expect(r.resetAt).toBeGreaterThan(0);
  });

  it("allows connections up to the limit", async () => {
    await checkRateLimit(kv, "1.2.3.4", cfg); // 1
    await checkRateLimit(kv, "1.2.3.4", cfg); // 2
    const r = await checkRateLimit(kv, "1.2.3.4", cfg); // 3 — at limit
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it("blocks the connection that exceeds the limit", async () => {
    await checkRateLimit(kv, "1.2.3.4", cfg); // 1
    await checkRateLimit(kv, "1.2.3.4", cfg); // 2
    await checkRateLimit(kv, "1.2.3.4", cfg); // 3
    const r = await checkRateLimit(kv, "1.2.3.4", cfg); // 4 — over limit
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.resetAt).toBeGreaterThan(0);
  });

  it("counts persist — subsequent calls after block also return !allowed", async () => {
    for (let i = 0; i < cfg.maxConnections; i++) {
      await checkRateLimit(kv, "1.2.3.4", cfg);
    }
    const r1 = await checkRateLimit(kv, "1.2.3.4", cfg);
    const r2 = await checkRateLimit(kv, "1.2.3.4", cfg);
    expect(r1.allowed).toBe(false);
    expect(r2.allowed).toBe(false);
  });

  it("does not count a different IP against the same limit", async () => {
    for (let i = 0; i < cfg.maxConnections + 1; i++) {
      await checkRateLimit(kv, "1.2.3.4", cfg);
    }
    const r = await checkRateLimit(kv, "5.6.7.8", cfg);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(cfg.maxConnections - 1);
  });

  it("resets the counter when the window has expired", async () => {
    // Write a stale entry that has already expired.
    const staleStart = Math.floor(Date.now() / 1000) - cfg.windowSeconds - 1;
    await kv.put("rl:1.2.3.4", JSON.stringify({ count: cfg.maxConnections, windowStart: staleStart }));

    const r = await checkRateLimit(kv, "1.2.3.4", cfg);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(cfg.maxConnections - 1);
  });

  it("fresh entry has resetAt ≈ now + windowSeconds", async () => {
    const before = Math.floor(Date.now() / 1000);
    const r = await checkRateLimit(kv, "1.2.3.4", cfg);
    const after = Math.floor(Date.now() / 1000);
    expect(r.resetAt).toBeGreaterThanOrEqual(before + cfg.windowSeconds);
    expect(r.resetAt).toBeLessThanOrEqual(after + cfg.windowSeconds);
  });
});
