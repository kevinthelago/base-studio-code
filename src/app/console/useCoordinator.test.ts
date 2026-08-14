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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useCoordinator } from "./useCoordinator";
import { injectWake, actuateWake } from "@/shared/lib/fleet/coordinatorActuate";
import { log } from "@/shared/lib/core/log";
import { ingestCoordLog } from "@/shared/lib/fleet/coordination";

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

// #the-refusal-warning-replays-the-whole-log-every-minute — report each refusal once, not once a minute.
//
// THE BUG THIS PINS. Same root cause as the block above, on the one surviving reporting path: the hook
// re-derives `refused` from the WHOLE tail on every read, and nothing ever prunes those lines out of the
// tail. Warning unguarded therefore re-announced the same fixed, months-old refusals on every change
// event AND on `useLogStream`'s 60s backstop — measured at 1,729 warnings from 19 real events, a block
// of 19 every minute for as long as the app ran, all of it about a fault already fixed.
//
// The assertions are about the SECOND read, because the first one was always correct. A test that only
// mounts the hook passes just as well against the unguarded version.
const OTHER_DIRECTOR = "other:director"; // a DIFFERENT project from WORKER (`demo:api`) — hence refused.

/** One cross-project `answer` line: `<ts> \t <emitter> \t answer \t <target> \t <body>`. */
function refusalLine(iso: string, target = WORKER): string {
  return [iso, OTHER_DIRECTOR, "answer", target, "not my fleet"].join("	");
}

describe("useCoordinator — the cross-project refusal report", () => {
  const FIRST = "2026-08-12T15:09:25Z";
  const LATER = "2026-08-12T16:00:00Z";
  let lines: string[];
  let fireChange: (() => void)[];
  let warned: string[];
  let warnSpy: { mockRestore(): void };

  /** How many reads the hook has issued — what a re-read is awaited on. */
  const reads = () =>
    vi.mocked(invoke).mock.calls.filter((c: unknown[]) => String(c[0]).startsWith("logs_")).length;
  /** Only the refusal warnings; the hook may legitimately warn about other things. */
  const refusalWarns = () => warned.filter((m) => m.includes("refused a cross-project"));

  /** Fire the `logs://coord` change event and wait for the read it triggers to land. */
  async function reread(): Promise<void> {
    const before = reads();
    fireChange.forEach((f) => f());
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  }

  beforeEach(() => {
    lines = [refusalLine(FIRST)];
    fireChange = [];
    warned = [];
    vi.mocked(listen).mockImplementation((_event: string, handler: (e: never) => void) => {
      fireChange.push(() => handler(undefined as never));
      return Promise.resolve(() => {});
    });
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "logs_tail" || cmd === "logs_coord") return Promise.resolve([...lines]);
      if (cmd.startsWith("logs_")) return Promise.resolve([]);
      return Promise.resolve(null);
    });
    warnSpy = vi.spyOn(log, "warn").mockImplementation((m: string) => { warned.push(m); });
  });

  afterEach(() => { warnSpy.mockRestore(); });

  it("the fixture is REAL — the line ingests as one refusal", () => {
    // GUARD THE GUARD, as above. "Warned exactly once" is satisfied just as well by a fixture that
    // produces NO refusal at all, so pin that this log really does refuse something.
    const r = ingestCoordLog([refusalLine(FIRST)]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]).toMatchObject({ kind: "answer", from: OTHER_DIRECTOR, target: WORKER });
  });

  it("warns once for a refusal, and NOT again when the same log is re-read", async () => {
    renderHook(() => useCoordinator());
    await waitFor(() => expect(refusalWarns()).toHaveLength(1));

    // The unguarded version warns again here, and again on every read after it — forever, because the
    // entry never leaves the tail.
    await reread();
    await reread();
    expect(refusalWarns()).toHaveLength(1);
  });

  it("warns AGAIN for a new refusal — the guard is per event, not per sender/target pair", async () => {
    // The reason `refusalKey` carries `at`. The same director really can misdirect the same worker
    // again, and that second attempt is news the sender has to hear; a pair-keyed guard would swallow
    // it behind the first key and silently under-report a live fault.
    renderHook(() => useCoordinator());
    await waitFor(() => expect(refusalWarns()).toHaveLength(1));

    lines.push(refusalLine(LATER));
    await reread();
    expect(refusalWarns()).toHaveLength(2);
  });
});
