# relay/DECISIONS.md

## REL-relay-rl (#473) — per-IP rate-limiting

**Date:** 2026-06-11

### What was built

Optional, opt-in per-IP connection rate-limiting via Workers KV (`src/rateLimit.ts`).
The binding (`RATE_LIMIT_KV`) is absent by default — the zero-binding one-click
"Deploy to Cloudflare" BYO flow is fully unchanged and unaffected.

### Why the existing controls suffice for single-user BYO

The controls from #197 already cover the BYO case:

- **High-entropy room ids** (16–64 chars, base64url) — a room can't be guessed.
- **Capacity cap** — 1 host + `MAX_GUESTS` (3) guests max; extra connections are
  rejected with 409.
- **Idle timeout** (`IDLE_TIMEOUT_MS` = 5 min) — stale rooms torn down automatically.
- **Absolute TTL** (`ROOM_TTL_MS` = 60 min) — rooms can't live forever regardless of activity.
- **Frame-size cap** (`MAX_FRAME_BYTES` = 256 KiB) — bandwidth abuse closed at 1009.

A BYO relay is already reachable only by whoever knows both the relay URL and a valid
room id. Rate-limiting adds no meaningful protection in that context.

### When to enable rate-limiting

Enable `RATE_LIMIT_KV` when running a **shared or public-facing relay** (multiple users,
relay URL is semi-public). See `wrangler.toml` for step-by-step instructions.

### Design choices (v1)

| Choice | Rationale |
|--------|-----------|
| Workers KV (not a Durable Object counter) | No added DO migration; KV is on the Workers free plan; zero-binding default stays zero-binding by default |
| Fixed-window semantics | Simple; adequate for connection-rate limiting; KV TTL naturally handles cleanup |
| Always write on reject | Prevents a sustained burst from bypassing the limit at a window boundary |
| `CF-Connecting-IP` header | Cloudflare-set; cannot be spoofed by clients; correct for any Worker rate limiter |
| Default: 20 connections / 60 s | Conservative for a relay; most legitimate reconnects fit well within this; tune via `DEFAULT_RATE_LIMIT` in `src/rateLimit.ts` |
| No env-var config | Keeps deployment simple; customization is a code edit (acceptable for a self-hosted tool) |
