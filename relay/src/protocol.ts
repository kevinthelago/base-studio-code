// Relay protocol — pure decision logic for the zero-knowledge tunnel relay (#241).
//
// The relay is a blind pipe: it routes opaque frames between a desktop (host) and
// mobile (guest) peers that share a `room`, and can never read content (the payload is
// a Noise-encrypted ciphertext — see docs/tunnel-protocol.md). This module holds the
// transport-free decisions (room-id validation, capacity, frame-size, connect parsing)
// so they're unit-testable without a workerd runtime; the Durable Object (`room.ts`)
// and Worker entry (`worker.ts`) are thin glue over these.

/** Max bytes per forwarded frame — a generous ciphertext cap; larger ⇒ abuse/bug. */
export const MAX_FRAME_BYTES = 256 * 1024;

/** Close a room after this long with no traffic (reset on every frame). */
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Absolute room lifetime cap, independent of activity. */
export const ROOM_TTL_MS = 60 * 60 * 1000;

/** At most one host + this many guests share a room. */
export const MAX_GUESTS = 3;

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
