import { describe, it, expect, vi } from "vitest";
import {
  mapDevicePoll, SLOW_DOWN_BUMP_SEC, runDeviceFlow,
  type DeviceStartInfo, type DevicePollResult, type DeviceFlowDeps,
} from "../lib/githubDeviceFlow";

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

describe("runDeviceFlow (#594)", () => {
  const START: DeviceStartInfo = {
    device_code: "dc", user_code: "UC-123", verification_uri: "https://github.com/login/device",
    interval: 1, expires_in: 900,
  };
  // Build deps with a scripted poll sequence and no-real-time sleep/now.
  function deps(polls: DevicePollResult[], over: Partial<DeviceFlowDeps> = {}) {
    let i = 0;
    const onSuccess = vi.fn();
    const onDevice = vi.fn();
    const onError = vi.fn();
    const base: DeviceFlowDeps = {
      start: vi.fn(async () => START),
      poll: vi.fn(async () => polls[Math.min(i++, polls.length - 1)]),
      sleep: async () => {},          // no real waiting
      now: () => 0,                   // never hits the expiry deadline
      isCancelled: () => false,
      onDevice, onSuccess, onError,
      ...over,
    };
    return { base, onSuccess, onDevice, onError };
  }

  it("polls past pending until success, then calls onSuccess with the token", async () => {
    const { base, onSuccess, onError } = deps([
      { error: "authorization_pending" },
      { error: "slow_down" },
      { access_token: "gho_tok" },
    ]);
    const outcome = await runDeviceFlow(base);
    expect(outcome).toEqual({ kind: "connected" });
    expect(onSuccess).toHaveBeenCalledWith("gho_tok");
    expect(onError).not.toHaveBeenCalled();
  });

  it("REGRESSION: onSuccess (the store write) fires even with no UI callbacks — i.e. survives unmount", async () => {
    // Simulate the component being gone: onDevice/onError omitted. The connection
    // must still complete — this is the navigate-away-mid-flow bug.
    const onSuccess = vi.fn();
    const outcome = await runDeviceFlow({
      start: async () => START,
      poll: async () => ({ access_token: "gho_after_nav" }),
      sleep: async () => {},
      now: () => 0,
      isCancelled: () => false,
      onSuccess,
    });
    expect(outcome).toEqual({ kind: "connected" });
    expect(onSuccess).toHaveBeenCalledWith("gho_after_nav");
  });

  it("stops without onSuccess when cancelled (a restart), not on unmount", async () => {
    const { base, onSuccess } = deps([{ access_token: "gho_tok" }], { isCancelled: () => true });
    const outcome = await runDeviceFlow(base);
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("surfaces a poll error and stops", async () => {
    const { base, onSuccess, onError } = deps([{ error: "access_denied" }]);
    const outcome = await runDeviceFlow(base);
    expect(outcome.kind).toBe("error");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
  });

  it("expires when the deadline passes before authorization", async () => {
    let t = 0;
    const { base, onError } = deps([{ error: "authorization_pending" }], {
      now: () => (t += 1_000_000),   // jump past expires_in on the first check
    });
    const outcome = await runDeviceFlow(base);
    expect(outcome.kind).toBe("expired");
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/expired/i));
  });
});
