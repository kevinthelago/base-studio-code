# relay/DECISIONS.md

## relay-evicts-the-silent-guest — a full room evicts rather than refuses

**Date:** 2026-09-19

**The bug.** A backgrounded iPhone, or one that moves between Wi-Fi and cellular, drops its
socket without a close frame. The room kept counting it: with the desktop streaming into the
room the idle alarm never fired, so the dead socket held its slot until the 60-minute TTL.
Three such drops and every reconnect got `409 room_full` — the phone locked out by its own
ghosts, for up to an hour.

**The fix.** Admission evicts instead of refusing a GUEST: when the room is full, the guest
with the oldest last sign of life (join, last frame, or last heartbeat — `lastSeenOf`) is
closed with `4001` and the newcomer takes its place. Sockets already closing no longer count.
A `ping`/`pong` heartbeat is answered by the runtime's auto-response, so it costs no wake and
leaves the timestamp admission reads. The host is never evicted by a guest, and a second
host is still `host_taken`: the desktop serves one phone per room, so the realistic newcomer
is the same phone coming back, but taking the host seat is a different trust question.

**Revised the same day — one phone per room, and an active sweep** (maintainer). `MAX_GUESTS`
is now 1, matching the desktop, which serves one phone per room: with one slot, arrival
eviction IS newest-wins, and the phone does not auto-redial a `4001`, so two devices cannot
push each other out in a loop. And rather than only finding a dead phone when a reconnect
bumps into it, the room's alarm also wakes every 30 s while a guest is present and closes one
that heartbeated and then went silent for 60 s (`4002`, `staleGuests`). A sweep scheduled is
never pushed later by traffic — MEASURED in `wrangler dev`: re-arming at now+30 s on each host
frame meant the sweep never ran (`nextWakeAt` keeps the pending one). The teardown deadline is
persisted for the sweep to tell the two alarms apart, throttled to moves of 30 s so a streaming
host does not add a storage write per frame.

**Why least-recently-seen and not newest-wins (superseded by the one-phone cap above).** Newest-wins would make two live devices
push each other out forever, each auto-reconnecting. Least-recently-seen evicts only once
the room is full, and a live guest that heartbeats is never the oldest.

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
