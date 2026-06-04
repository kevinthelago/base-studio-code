# msc-tunnel-relay

A **zero-knowledge relay** for the [Mobile Studio Code](../) tunnel. It lets your phone
reach your desktop **from anywhere** without port-forwarding, while never being able to
read your terminal.

## What it is

A tiny Cloudflare **Worker + Durable Object**. Both your desktop and your phone *dial
out* to it and join a shared `room`; the relay copies frames between them. That's all it
does — it's a **blind pipe**:

- The payloads it forwards are **Noise-encrypted ciphertext** (the desktop and phone run
  an end-to-end [Noise IK](https://noiseprotocol.org/) session *inside* the relayed
  connection). The relay has no key and can never decrypt, read, or inject data.
- Because it's zero-knowledge, hosting it on a third party adds **no confidentiality
  trust** — and you deploy it into **your own** Cloudflare account, so nobody else runs
  shared infrastructure for it either.

```
   phone ──wss (real TLS)──▶  this Worker + Durable Object (room)  ◀──wss (real TLS)── desktop
      └──────────────────── Noise IK session (end-to-end) ──────────────────────┘
                 the relay only ever sees { room, ciphertext }
```

## Deploy it (free, ~2 minutes)

You need a Cloudflare account. The **free** Workers plan is enough — this relay uses a
SQLite-backed Durable Object (see `wrangler.toml`), which is included on the free plan,
plus WebSockets.

> The one-click button points at `develop` until `relay/` is promoted to `main`. If it
> 404s, use the CLI path below — it's the reliable one.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kevinthelago/base-studio-code/tree/develop/relay)

Or from a clone:

```bash
cd relay
npm install
npx wrangler login      # opens a browser to authorize your account
npm run deploy          # prints your relay URL, e.g. https://msc-tunnel-relay.<you>.workers.dev
```

Then paste that URL into the desktop app's **Settings → Mobile tunnel → Relay** field.
The desktop connects, allocates a room, and shows the pairing QR.

## Endpoints

| Method | Path        | Purpose |
|--------|-------------|---------|
| `GET`  | `/health`   | Liveness probe → `{ ok, service, version }`. Never touches a room. |
| `GET`  | `/connect?room=<id>&role=host\|guest` | WebSocket upgrade; both peers with the same `room` join the same Durable Object. |

## Abuse controls

- **Room ids** are high-entropy, URL-safe, 16–64 chars (`validateRoomId`) — unguessable.
- **Capacity**: one host + up to `MAX_GUESTS` guests per room (`roleFor`); extra
  connections are rejected (`409 host_taken` / `room_full`).
- **Frame size** is capped at `MAX_FRAME_BYTES` (`tooLarge`); oversize frames close the
  socket (`1009`).
- **Idle timeout**: a room with no traffic for `IDLE_TIMEOUT_MS` is torn down via a
  Durable Object alarm. The **WebSocket Hibernation API** evicts idle rooms from memory
  so they cost ~nothing.
- **Absolute TTL**: a room is also capped at `ROOM_TTL_MS` from creation
  (`nextAlarmAt` / `roomLifetimeExceeded`) — even a continuously busy room is torn down
  once it reaches the cap, so the idle re-arm can't keep a session open indefinitely.
- **Logging is metadata-only** — the relay cannot log content it cannot read.

> **Not in v1:** per-IP connection rate-limiting (KV counters). It's intentionally out of
> scope — the controls above already bound abuse on a single-user BYO relay, and a KV
> binding would add friction to the one-click deploy. Tracked as a follow-up under epic
> [#210](https://github.com/kevinthelago/base-studio-code/issues/210).

## Develop & test

```bash
npm run dev         # wrangler dev (local workerd)
npm test            # vitest — pure protocol logic (src/protocol.ts)
npm run typecheck   # tsc against @cloudflare/workers-types
```

The transport-free decision logic lives in [`src/protocol.ts`](src/protocol.ts) and is
unit-tested without a workerd runtime; [`src/room.ts`](src/room.ts) (the Durable Object)
and [`src/worker.ts`](src/worker.ts) are thin glue over it.

See [`../docs/tunnel-protocol.md`](../docs/tunnel-protocol.md) for the wire protocol and
[#197](https://github.com/kevinthelago/base-studio-code/issues/197) for the architecture.
