// The SEAM (#the-wake-adapter-drops-the-stream-it-was-handed).
//
// `the-director-cannot-start-a-stream-that-never-launched` taught three things to carry a stream row:
// Rust resolves it, `fleetWakeBridge` forwards it, `wakePane` adopts it. This adapter binds the last
// two, and it bound them with `wakePane: (p, t) => …wakePane(p, t)` — a two-parameter arrow. The row
// arrived and was dropped on the floor, and the store refused exactly as it had before the fix, so the
// symptom was identical to the bug and the diagnosis went to the frontend twice and to Rust once.
//
// NEITHER GATE COULD SEE IT:
//   · TypeScript accepts a 2-arg function where a 3-arg type is expected. That is sound and
//     deliberate, so `tsc` was right to stay green.
//   · Both SIDES were tested — the bridge's own test asserts `deps.wakePane` is called with the row,
//     against a mock; the store's test calls `wakePane` directly with one. The join was the only
//     untested thing, and the join is where the value went.
//
// So this test exists at the seam and nowhere else: it drives the REAL listener with a REAL payload
// and asserts what the REAL store action received.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { useFleetWakeBridge } from "@/app/useFleetWakeBridge";
import { useAppStore } from "@/store";

type Handler = (e: { payload: Record<string, unknown> }) => Promise<void> | void;

/** Mount the hook and hand back the listener it registered for `bsc://fleet-wake`. */
async function mountAndCapture(): Promise<Handler> {
  const mock = vi.mocked(listen);
  mock.mockClear();
  mock.mockResolvedValue(vi.fn() as never);
  renderHook(() => useFleetWakeBridge());
  const call = mock.mock.calls.find(([evt]) => evt === "bsc://fleet-wake");
  expect(call, "the hook registers a bsc://fleet-wake listener").toBeTruthy();
  return call![1] as unknown as Handler;
}

const STREAM = { id: "api", name: "API", repo: "own/api", owns: [], issues: [], dependsOn: [], cwd: "/wt/api" };

describe("the wake adapter forwards everything it is handed", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("passes the plan row through to wakePane", async () => {
    const wakePane = vi.fn().mockReturnValue(true);
    vi.spyOn(useAppStore, "getState").mockReturnValue({ ...useAppStore.getState(), wakePane } as never);

    const handler = await mountAndCapture();
    await handler({ payload: { id: "r1", paneId: "demo:api", prompt: "start on #7", stream: STREAM } });

    expect(wakePane).toHaveBeenCalledWith("demo:api", "start on #7", STREAM);
  });

  it("still calls wakePane with three arguments when there is no row", async () => {
    // The arity is the whole point: `(p, t)` typechecks against the 3-arg dep and truncates in silence,
    // so asserting the ARGUMENT COUNT is what makes a narrowed adapter fail this test rather than pass.
    const wakePane = vi.fn().mockReturnValue(true);
    vi.spyOn(useAppStore, "getState").mockReturnValue({ ...useAppStore.getState(), wakePane } as never);

    const handler = await mountAndCapture();
    await handler({ payload: { id: "r2", paneId: "demo:api" } });

    expect(wakePane.mock.calls[0]).toHaveLength(3);
    expect(wakePane.mock.calls[0][2]).toBeUndefined();
  });
});
