// Relay protocol — pure decision logic for the zero-knowledge tunnel relay (#241).
//
// The relay is a blind pipe: it routes opaque frames between a desktop (host) and
// mobile (guest) peers that share a `room`, and can never read content (the payload is
// a Noise-encrypted ciphertext — see docs/tunnel-protocol.md). This module holds the
// transport-free decisions (room-id validation, capacity, frame-size, connect parsing)
// so they're unit-testable without a workerd runtime; the Durable Object (`room.ts`)
// and Worker entry (`worker.ts`) are thin glue over these.

/** Relay identity + version, surfaced by the `/health` liveness probe. */
export const RELAY_SERVICE = "msc-tunnel-relay";
export const RELAY_VERSION = "0.1.0";

/**
 * The `/health` response body — content-free liveness metadata only (no room ids, no
 * peer state, no secrets), so it's safe to serve CORS-open to the desktop webview's
 * "Test relay" probe. Keep it free of anything a third party shouldn't learn.
 */
export function healthBody(): { ok: true; service: string; version: string } {
  return { ok: true, service: RELAY_SERVICE, version: RELAY_VERSION };
}

/** CORS headers for `/health` — open `*` because the body is public liveness metadata. */
export const HEALTH_CORS_HEADERS = { "Access-Control-Allow-Origin": "*" } as const;

/** Max bytes per forwarded frame — a generous ciphertext cap; larger ⇒ abuse/bug. */
export const MAX_FRAME_BYTES = 256 * 1024;

/** Close a room after this long with no traffic (reset on every frame). */
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Absolute room lifetime cap, independent of activity. */
export const ROOM_TTL_MS = 60 * 60 * 1000;

/**
 * ONE PHONE PER ROOM: at most one host + this many guests share a room. The desktop serves exactly one
 * phone per room (its `serve` loop is one Noise session), so a second guest could only ever break the
 * first; a phone that comes back replaces its own old socket (see {@link guestsToEvict}).
 */
export const MAX_GUESTS = 1;

// Room ids are high-entropy, URL-safe (base64url alphabet), 16–64 chars. Enough
// entropy that a room can't be guessed; bounded so it can't be abused as storage.
const ROOM_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Whether `id` is a well-formed, high-entropy room id. */
export function validateRoomId(id: string): boolean {
  return ROOM_ID_RE.test(id);
}

/** Whether a frame of `size` bytes exceeds the forward cap. */
export function tooLarge(size: number): boolean {
  return size > MAX_FRAME_BYTES;
}

export type Role = "host" | "guest";

export interface RoomCounts {
  hostCount: number;
  guestCount: number;
}

export type RoleDecision =
  | { ok: true; role: Role }
  | { ok: false; error: "host_taken" | "room_full" | "bad_role" };

/**
 * Decide the role a new connection may take, given the room's current occupancy.
 * One host max; up to {@link MAX_GUESTS} guests. An unknown requested role is rejected.
 */
export function roleFor(counts: RoomCounts, requested: string): RoleDecision {
  if (requested !== "host" && requested !== "guest") {
    return { ok: false, error: "bad_role" };
  }
  if (requested === "host") {
    if (counts.hostCount >= 1) return { ok: false, error: "host_taken" };
    return { ok: true, role: "host" };
  }
  if (counts.guestCount >= MAX_GUESTS) return { ok: false, error: "room_full" };
  return { ok: true, role: "guest" };
}

/**
 * The text a peer sends to prove it is alive, and the relay's answer. The relay answers it itself —
 * the Hibernation API's auto-response — so a heartbeat neither wakes the room nor reaches the other
 * peer, and the runtime records WHEN each socket last pinged. That timestamp is how the relay tells a
 * live-but-quiet guest from a dead one. Plain text never collides with the tunnel, whose every frame
 * is binary Noise ciphertext, and a peer that never pings loses nothing.
 */
export const HEARTBEAT_PING = "ping";
export const HEARTBEAT_PONG = "pong";

/** The close code for a guest pushed out to make room for a new one (4000–4999: application-defined). */
export const EVICTED_CLOSE_CODE = 4001;
export const EVICTED_REASON = "evicted: a newer guest joined";
/** The close code for a guest the relay found dead: it heartbeated, then went silent. */
export const UNRESPONSIVE_CLOSE_CODE = 4002;
export const UNRESPONSIVE_REASON = "guest stopped responding";

/** How often a room with a guest in it wakes to check that guest is still alive. */
export const LIVENESS_SWEEP_MS = 30 * 1000;
/** A heartbeating guest silent this long is dead — three missed 20s heartbeats. */
export const GUEST_STALE_MS = 60 * 1000;

/** A guest socket as the admission decision sees it: when it last showed a sign of life. */
export interface GuestLiveness {
  /** ms epoch — the latest of: when it joined, its last frame, its last heartbeat. */
  lastSeen: number;
}

/**
 * Which guests to push out so ONE more can join (relay-evicts-the-silent-guest): none while there is
 * a free slot, otherwise the least recently seen — returned as indices into `guests`.
 *
 * WHY EVICT rather than refuse. A phone that is backgrounded, or that moves between Wi-Fi and cellular,
 * vanishes without a close frame, and its socket keeps its slot until the edge notices — which, with a
 * host streaming into the room, can be the whole {@link ROOM_TTL_MS}. Three such drops and every
 * reconnect was refused `room_full` for up to an hour: the phone locked out by its own ghosts. The
 * guest that has been silent longest is, overwhelmingly, one of those; a live guest pings
 * ({@link HEARTBEAT_PING}) and stays fresh. The host is never evicted by a guest.
 */
export function guestsToEvict(guests: readonly GuestLiveness[], max: number = MAX_GUESTS): number[] {
  const excess = guests.length - max + 1;
  if (excess <= 0) return [];
  return guests
    .map((g, i) => ({ i, lastSeen: g.lastSeen }))
    .sort((a, b) => a.lastSeen - b.lastSeen || a.i - b.i)
    .slice(0, excess)
    .map((g) => g.i);
}

/** A guest as the liveness sweep sees it. */
export interface GuestHeartbeat extends GuestLiveness {
  /** It has pinged at least once — it runs a heartbeat, so its silence MEANS something. */
  pinged: boolean;
}

/**
 * Which guests the relay should close as dead, found by the room's own sweep rather than by waiting for
 * a reconnect to bump into them. Only a guest that HAS heartbeated is judged: silence from a phone build
 * that never pings says nothing, and closing it would cut off a live phone. Returned as indices.
 */
export function staleGuests(guests: readonly GuestHeartbeat[], now: number, staleMs: number = GUEST_STALE_MS): number[] {
  const out: number[] = [];
  guests.forEach((g, i) => { if (g.pinged && now - g.lastSeen >= staleMs) out.push(i); });
  return out;
}

/**
 * When the room's alarm should next fire: its teardown deadline, or sooner — the next liveness sweep —
 * while a guest is present. A room with no guest sleeps until teardown, so an empty room costs nothing.
 *
 * A SWEEP ALREADY SCHEDULED STAYS WHERE IT IS. The room re-arms on every frame, and the host streams
 * frames every few seconds; measured against a live workerd, "now + sweepMs" on each frame pushed the
 * sweep forward forever and it never ran — a dead phone kept its slot exactly as before. So a pending
 * sweep in the future is kept, and only a missing or past one is rescheduled.
 */
export function nextWakeAt(
  teardownAt: number,
  now: number,
  hasGuest: boolean,
  pendingSweepAt?: number,
  sweepMs: number = LIVENESS_SWEEP_MS,
): { wakeAt: number; sweepAt: number | undefined } {
  if (!hasGuest) return { wakeAt: teardownAt, sweepAt: undefined };
  const sweepAt = pendingSweepAt !== undefined && pendingSweepAt > now ? pendingSweepAt : now + sweepMs;
  return { wakeAt: Math.min(teardownAt, sweepAt), sweepAt };
}

/** A socket's last sign of life: the latest of its join, its last frame and its last heartbeat. */
export function lastSeenOf(joinedAt: number, lastFrameAt?: number, lastPingAt?: number | null): number {
  return Math.max(joinedAt, lastFrameAt ?? 0, lastPingAt ?? 0);
}

/**
 * When the room's next teardown alarm should fire, given when it was created and now.
 * It's the earlier of two deadlines: the **idle** cutoff (reset on every frame, so a
 * silent room dies after {@link IDLE_TIMEOUT_MS}) and the **absolute** lifetime cap
 * (fixed at creation, so even a continuously busy room can't outlive {@link ROOM_TTL_MS}).
 * Taking the min is what makes the TTL bite — without it the per-frame idle re-arm would
 * push the alarm forward forever and the absolute cap would never fire.
 */
export function nextAlarmAt(
  createdAt: number,
  now: number,
  idleMs: number = IDLE_TIMEOUT_MS,
  ttlMs: number = ROOM_TTL_MS,
): number {
  return Math.min(createdAt + ttlMs, now + idleMs);
}

/** Whether a room created at `createdAt` has reached its absolute lifetime cap by `now`. */
export function roomLifetimeExceeded(
  createdAt: number,
  now: number,
  ttlMs: number = ROOM_TTL_MS,
): boolean {
  return now - createdAt >= ttlMs;
}

export interface ConnectTarget {
  room: string;
  role: string;
}

export type ConnectParse =
  | { ok: true; target: ConnectTarget }
  | { ok: false; error: "missing_room" | "bad_room" };

/**
 * Parse a `/connect?room=&role=` upgrade URL into a validated target. `role`
 * defaults to `guest`; the room must pass {@link validateRoomId}. The role itself is
 * re-checked against live occupancy inside the room (see {@link roleFor}).
 */
export function parseConnect(url: URL): ConnectParse {
  const room = url.searchParams.get("room");
  const role = url.searchParams.get("role") ?? "guest";
  if (!room) return { ok: false, error: "missing_room" };
  if (!validateRoomId(room)) return { ok: false, error: "bad_room" };
  return { ok: true, target: { room, role } };
}
