// #coordinator-stops-waking-sessions — the coordinator observes and notifies; it never resumes.
//
// THE BUG THIS PINS. `useCoordinator` re-derives from the WHOLE coord log on every read, including the
// one on mount. It used to fire `injectWake` for every `bsc-answer` and `actuateWake` for every
// `bsc-assign` stamped within FRESH_MS (15 minutes), so simply STARTING THE APP replayed a quarter
// hour of coordination traffic as live wakes — five to nine panes opening a Claude turn at once, with
// nobody having clicked anything.
//
// A recency gate cannot fix that, which is why there is no "shorter FRESH_MS" version of this test:
// any window replays whatever falls inside it. The rule is that the app does not resume sessions at
// all, so these assertions are about ZERO wakes, not fewer.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useCoordinator } from "@/app/console/useCoordinator";
import { injectWake, actuateWake } from "@/shared/lib/fleet/coordinatorActuate";

vi.mock("@/shared/lib/fleet/coordinatorActuate", () => ({
  injectWake: vi.fn().mockResolvedValue(true),
  actuateWake: vi.fn().mockResolvedValue(true),
}));

// No phone paired — the push path short-circuits, leaving the wake behaviour as the only variable.
vi.mock("@/features/tunnel", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  tunnelStatus: vi.fn().mockResolvedValue({ running: false }),
  tunnelSetSessions: vi.fn().mockResolvedValue(undefined),
}));

const WORKER = "demo:api";
const DIRECTOR = "demo:director";

/** A coord log whose answer and assign are BOTH seconds old — squarely inside the old 15-minute
 *  window, so under the previous behaviour each of these lines fired a wake on mount.
 *
 *  TAB-SEPARATED, because that is the real wire format (`parseCoordLine` splits on 	 and drops any
 *  line with fewer than four columns). The first draft of this fixture used JSON and every line
 *  parsed to null — so the state was empty and "no wakes" was trivially true. `theFixtureIsReal`
 *  below exists to make that failure impossible to repeat. */
function freshLog(): string[] {
  const at = new Date().toISOString();
  return [
    [at, WORKER, "ask", "who owns #158?"].join("	"),
    // answer: payload = <target> 	 <answer>
    [at, DIRECTOR, "answer", WORKER, "release-eng owns it"].join("	"),
    // assign: payload = <target> 	 <body> 	 <issueId?> 	 <title?>
    [at, DIRECTOR, "assign", WORKER, "replace the buttons", "512", "Replace bespoke buttons"].join("	"),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listen).mockImplementation(() => Promise.resolve(() => {}));
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "logs_tail" || cmd === "logs_coord") return Promise.resolve(freshLog());
    if (cmd.startsWith("logs_")) return Promise.resolve([]);
    return Promise.resolve(null);
  });
});

describe("useCoordinator (#coordinator-stops-waking-sessions)", () => {
  it("performs NO wake for a fresh answer", async () => {
    renderHook(() => useCoordinator());
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
    expect(injectWake).not.toHaveBeenCalled();
  });

  it("performs NO wake for a fresh assign", async () => {
    renderHook(() => useCoordinator());
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
    expect(actuateWake).not.toHaveBeenCalled();
  });

  it("fires no wake ON MOUNT — the boot replay is what started sessions at app start", async () => {
    // The whole failure mode in one assertion: mounting the hook against a log full of recent
    // coordination must move nothing. Re-mounting (an app restart) must stay silent too.
    const first = renderHook(() => useCoordinator());
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
    first.unmount();
    vi.mocked(invoke).mockClear();

    renderHook(() => useCoordinator());
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
    expect(injectWake).not.toHaveBeenCalled();
    expect(actuateWake).not.toHaveBeenCalled();
  });

  it("the fixture is REAL — it parses into an answer and an assign", async () => {
    // GUARD THE GUARD. Every assertion above is a NEGATIVE ("no wake"), and a negative passes just
    // as well against a log that parsed to nothing. The first draft of this file used JSON lines,
    // which `parseCoordLine` rejects outright, so the suite was green and proved nothing. This pins
    // that the fixture really does produce the two events whose wakes were removed.
    const { ingestCoordLog } = await import("@/shared/lib/fleet/coordination");
    const r = ingestCoordLog(freshLog()); // defaults to an empty state
    expect(r.answered.map((a) => a.session)).toEqual([WORKER]);
    expect(r.assigned.map((a) => a.session)).toEqual([WORKER]);
  });

  it("still projects the maintenance set — observing is not waking", async () => {
    // The reaper depends on this projection, and it moves no session. Removing the wakes must not
    // take it with them.
    const { useAppStore } = await import("@/store");
    const spy = vi.spyOn(useAppStore.getState(), "setPaneMaintaining");
    renderHook(() => useCoordinator());
    await waitFor(() => expect(spy).toHaveBeenCalled());
    spy.mockRestore();
  });
});
