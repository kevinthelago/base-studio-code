import { describe, it, expect } from "vitest";
import {
  validateRoomId,
  tooLarge,
  roleFor,
  parseConnect,
  nextAlarmAt,
  roomLifetimeExceeded,
  MAX_FRAME_BYTES,
  MAX_GUESTS,
  IDLE_TIMEOUT_MS,
  ROOM_TTL_MS,
} from "../src/protocol";

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
