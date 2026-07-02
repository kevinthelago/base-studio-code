import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { emptyCoordState, type CoordState, type Waiter } from "@/shared/lib/fleet/coordination";

// Keep the real resolver + prompt builders; only swap ingestCoordLog so the test controls
// the coordination state without authoring raw coord-log lines.
const ingestMock = vi.fn();
vi.mock("@/shared/lib/fleet/coordination", async (orig) => {
  const actual = await orig<typeof import("@/shared/lib/fleet/coordination")>();
  return { ...actual, ingestCoordLog: (...a: unknown[]) => ingestMock(...a) };
});

vi.mock("@/shared/lib/fleet/coordinatorActuate", () => ({
  actuateWake: vi.fn().mockResolvedValue(true),
  injectWake: vi.fn().mockResolvedValue(true),
}));

import { actuateWake, injectWake } from "@/shared/lib/fleet/coordinatorActuate";
import { useTunnelCoordControl } from "./useTunnelCoordControl";

const handlers: Record<string, (e: { payload: { session: string } }) => void> = {};

function ingestReturns(over: Partial<CoordState>, ready: Waiter[] = []) {
  ingestMock.mockReturnValue({
    state: { ...emptyCoordState(), ...over },
    woken: [], ready, answered: [], assigned: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(handlers)) delete handlers[k];
  vi.mocked(listen).mockImplementation((name, cb) => {
    handlers[name] = cb as (e: { payload: { session: string } }) => void;
    return Promise.resolve(() => {});
  });
  vi.mocked(invoke).mockResolvedValue(JSON.stringify([])); // `bsc logs tail coord` → [] (lines ignored; ingest is mocked)
});

describe("useTunnelCoordControl (#935)", () => {
  it("subscribes to both inbound coordination events", async () => {
    renderHook(() => useTunnelCoordControl());
    await waitFor(() => {
      expect(handlers["tunnel://coord-wake"]).toBeTypeOf("function");
      expect(handlers["tunnel://coord-approve"]).toBeTypeOf("function");
    });
  });

  it("routes a mobile approve into an in-place resume of a paused gate", async () => {
    ingestReturns({ waiting: [{ session: "api", reason: "ship it?", at: 0 }] });
    renderHook(() => useTunnelCoordControl());
    await waitFor(() => expect(handlers["tunnel://coord-approve"]).toBeTypeOf("function"));

    handlers["tunnel://coord-approve"]({ payload: { session: "api" } });

    await waitFor(() => expect(injectWake).toHaveBeenCalledWith("api", expect.stringMatching(/resumed/i)));
    expect(actuateWake).not.toHaveBeenCalled();
  });

  it("routes a mobile wake into a fresh relaunch of a ready dependency waiter", async () => {
    const ready: Waiter[] = [{ session: "web", deps: [], registeredAt: 0 }];
    ingestReturns({}, ready);
    renderHook(() => useTunnelCoordControl());
    await waitFor(() => expect(handlers["tunnel://coord-wake"]).toBeTypeOf("function"));

    handlers["tunnel://coord-wake"]({ payload: { session: "web" } });

    await waitFor(() => expect(actuateWake).toHaveBeenCalledWith("web", expect.any(String), expect.any(Function)));
    expect(injectWake).not.toHaveBeenCalled();
  });

  it("ignores a request naming a session that isn't parked", async () => {
    ingestReturns({});
    renderHook(() => useTunnelCoordControl());
    await waitFor(() => expect(handlers["tunnel://coord-wake"]).toBeTypeOf("function"));

    handlers["tunnel://coord-wake"]({ payload: { session: "ghost" } });

    // Give the async handler a chance to run, then assert nothing was actuated.
    await new Promise((r) => setTimeout(r, 0));
    expect(actuateWake).not.toHaveBeenCalled();
    expect(injectWake).not.toHaveBeenCalled();
  });
});
