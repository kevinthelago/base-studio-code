import { describe, it, expect } from "vitest";
import { mapDevicePoll, SLOW_DOWN_BUMP_SEC } from "../lib/githubDeviceFlow";

describe("mapDevicePoll", () => {
  it("an access_token -> success carrying the token", () => {
    expect(mapDevicePoll({ access_token: "gho_abc" }, 5)).toEqual({
      kind: "success",
      token: "gho_abc",
    });
  });

  it("access_token wins even if an error is also present", () => {
    const a = mapDevicePoll({ access_token: "gho_x", error: "slow_down" }, 5);
    expect(a).toEqual({ kind: "success", token: "gho_x" });
  });

  it("authorization_pending -> pending at the same interval", () => {
    expect(mapDevicePoll({ error: "authorization_pending" }, 7)).toEqual({
      kind: "pending",
      intervalSec: 7,
    });
  });

  it("slow_down -> pending with the interval bumped by 5s", () => {
    expect(mapDevicePoll({ error: "slow_down" }, 5)).toEqual({
      kind: "pending",
      intervalSec: 5 + SLOW_DOWN_BUMP_SEC,
    });
  });

  it("expired_token -> a restart-worthy error", () => {
    const a = mapDevicePoll({ error: "expired_token" }, 5);
    expect(a.kind).toBe("error");
    expect((a as { message: string }).message).toMatch(/expired/i);
  });

  it("access_denied -> a cancelled error", () => {
    const a = mapDevicePoll({ error: "access_denied" }, 5);
    expect(a.kind).toBe("error");
    expect((a as { message: string }).message).toMatch(/cancel/i);
  });

  it("an empty/missing result -> a generic unexpected error", () => {
    expect(mapDevicePoll({}, 5).kind).toBe("error");
    expect(mapDevicePoll({ access_token: null, error: null }, 5).kind).toBe("error");
    expect(mapDevicePoll({ error: "" }, 5).kind).toBe("error");
  });

  it("an unknown error string -> a fatal error echoing it", () => {
    const a = mapDevicePoll({ error: "incorrect_device_code" }, 5);
    expect(a.kind).toBe("error");
    expect((a as { message: string }).message).toContain("incorrect_device_code");
  });
});
