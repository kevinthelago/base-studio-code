import { describe, it, expect } from "vitest";
import {
  validateRoomId,
  tooLarge,
  roleFor,
  parseConnect,
  MAX_FRAME_BYTES,
  MAX_GUESTS,
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
