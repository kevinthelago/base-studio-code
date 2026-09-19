import { describe, it, expect } from "vitest";
import {
  validateRoomId,
  tooLarge,
  roleFor,
  parseConnect,
  nextAlarmAt,
  roomLifetimeExceeded,
  healthBody,
  HEALTH_CORS_HEADERS,
  RELAY_SERVICE,
  MAX_FRAME_BYTES,
  MAX_GUESTS,
  IDLE_TIMEOUT_MS,
  ROOM_TTL_MS,
  guestsToEvict,
  lastSeenOf,
} from "../src/protocol";

describe("/health probe payload (#930)", () => {
  it("identifies the relay so the desktop probe can tell it apart from a random 200", () => {
    expect(healthBody().service).toBe(RELAY_SERVICE);
    expect(healthBody().ok).toBe(true);
    expect(typeof healthBody().version).toBe("string");
  });

  it("stays content-free — only ok/service/version, never room/peer/secret data", () => {
    expect(Object.keys(healthBody()).sort()).toEqual(["ok", "service", "version"]);
  });

  it("stays CORS-open so the webview can probe it cross-origin", () => {
    expect(HEALTH_CORS_HEADERS["Access-Control-Allow-Origin"]).toBe("*");
  });
});

describe("validateRoomId", () => {
  it("accepts 16–64 char base64url ids", () => {
    expect(validateRoomId("abcdEFGH12345678")).toBe(true); // 16
    expect(validateRoomId("a".repeat(64))).toBe(true);
    expect(validateRoomId("room_id-with-dashes_and_more99")).toBe(true);
  });
  it("rejects too-short, too-long, or illegal-char ids", () => {
    expect(validateRoomId("tooshort")).toBe(false); // 8
    expect(validateRoomId("a".repeat(65))).toBe(false);
    expect(validateRoomId("has spaces 0000000000")).toBe(false);
    expect(validateRoomId("has/slash/0000000000")).toBe(false);
    expect(validateRoomId("")).toBe(false);
  });
});

describe("tooLarge", () => {
  it("flags frames over the cap", () => {
    expect(tooLarge(MAX_FRAME_BYTES)).toBe(false);
    expect(tooLarge(MAX_FRAME_BYTES + 1)).toBe(true);
    expect(tooLarge(0)).toBe(false);
  });
});

describe("roleFor", () => {
  it("admits a host when none present, rejects a second", () => {
    expect(roleFor({ hostCount: 0, guestCount: 0 }, "host")).toEqual({ ok: true, role: "host" });
    expect(roleFor({ hostCount: 1, guestCount: 0 }, "host")).toEqual({ ok: false, error: "host_taken" });
  });
  it("admits guests up to MAX_GUESTS, then room_full", () => {
    expect(roleFor({ hostCount: 1, guestCount: 0 }, "guest")).toEqual({ ok: true, role: "guest" });
    expect(roleFor({ hostCount: 1, guestCount: MAX_GUESTS - 1 }, "guest")).toEqual({ ok: true, role: "guest" });
    expect(roleFor({ hostCount: 1, guestCount: MAX_GUESTS }, "guest")).toEqual({ ok: false, error: "room_full" });
  });
  it("rejects an unknown role", () => {
    expect(roleFor({ hostCount: 0, guestCount: 0 }, "admin")).toEqual({ ok: false, error: "bad_role" });
  });
});

describe("nextAlarmAt", () => {
  it("picks the idle cutoff early in a room's life", () => {
    const createdAt = 1_000;
    const now = 2_000; // well before the TTL
    expect(nextAlarmAt(createdAt, now)).toBe(now + IDLE_TIMEOUT_MS);
  });
  it("clamps to the absolute TTL once the idle cutoff would exceed it", () => {
    const createdAt = 1_000;
    // Busy near the end of the room's life: idle re-arm would push past the TTL.
    const now = createdAt + ROOM_TTL_MS - IDLE_TIMEOUT_MS + 1_000;
    expect(nextAlarmAt(createdAt, now)).toBe(createdAt + ROOM_TTL_MS);
  });
  it("never lets a continuously-busy room re-arm past the TTL", () => {
    const createdAt = 0;
    // Simulate frame after frame right up against the cap.
    for (let now = 0; now <= ROOM_TTL_MS; now += IDLE_TIMEOUT_MS) {
      expect(nextAlarmAt(createdAt, now)).toBeLessThanOrEqual(createdAt + ROOM_TTL_MS);
    }
  });
});

describe("roomLifetimeExceeded", () => {
  it("is false before the TTL and true at/after it", () => {
    const createdAt = 5_000;
    expect(roomLifetimeExceeded(createdAt, createdAt)).toBe(false);
    expect(roomLifetimeExceeded(createdAt, createdAt + ROOM_TTL_MS - 1)).toBe(false);
    expect(roomLifetimeExceeded(createdAt, createdAt + ROOM_TTL_MS)).toBe(true);
    expect(roomLifetimeExceeded(createdAt, createdAt + ROOM_TTL_MS + 60_000)).toBe(true);
  });
});

describe("parseConnect", () => {
  const at = (qs: string) => parseConnect(new URL(`wss://relay.example.workers.dev/connect${qs}`));

  it("parses a valid room + explicit role", () => {
    expect(at("?room=abcdEFGH12345678&role=host")).toEqual({
      ok: true,
      target: { room: "abcdEFGH12345678", role: "host" },
    });
  });
  it("defaults role to guest", () => {
    expect(at("?room=abcdEFGH12345678")).toEqual({
      ok: true,
      target: { room: "abcdEFGH12345678", role: "guest" },
    });
  });
  it("rejects a missing room", () => {
    expect(at("")).toEqual({ ok: false, error: "missing_room" });
  });
  it("rejects a malformed room id", () => {
    expect(at("?room=short")).toEqual({ ok: false, error: "bad_room" });
  });
});

describe("guestsToEvict — a full room admits a new guest by pushing out the silent one (relay-evicts-the-silent-guest)", () => {
  it("evicts nobody while there is a free slot", () => {
    expect(guestsToEvict([])).toEqual([]);
    expect(guestsToEvict([{ lastSeen: 1 }, { lastSeen: 2 }])).toEqual([]);
  });

  it("evicts the least recently seen guest when the room is full — the phone's own dead sockets", () => {
    // Three drops from a backgrounded phone, none of which closed: the next reconnect used to be room_full.
    const guests = [{ lastSeen: 3_000 }, { lastSeen: 1_000 }, { lastSeen: 2_000 }];
    expect(guests.length).toBe(MAX_GUESTS);
    expect(guestsToEvict(guests)).toEqual([1]);
  });

  it("keeps a live guest whose heartbeat is recent, even though it joined first", () => {
    const live = { lastSeen: lastSeenOf(0, undefined, 9_000) };
    const dead = [{ lastSeen: lastSeenOf(5_000) }, { lastSeen: lastSeenOf(6_000, 6_500) }];
    expect(guestsToEvict([live, ...dead])).toEqual([1]);
  });

  it("evicts enough to leave exactly one free slot if the room is somehow over-full, oldest first, stable on ties", () => {
    expect(guestsToEvict([{ lastSeen: 5 }, { lastSeen: 5 }, { lastSeen: 1 }, { lastSeen: 5 }])).toEqual([2, 0]);
  });

  it("a last sign of life is the latest of join, frame and heartbeat", () => {
    expect(lastSeenOf(10)).toBe(10);
    expect(lastSeenOf(10, 30, 20)).toBe(30);
    expect(lastSeenOf(10, undefined, null)).toBe(10);
    expect(lastSeenOf(10, 5, 40)).toBe(40);
  });
});
