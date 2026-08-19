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
import { useCoordinator, resetCoordinatorDedupe } from "@/app/console/useCoordinator";
import { tunnelStatus, tunnelSetSessions } from "@/features/tunnel";
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
  // The dedupe guards are MODULE scope now (#coordinator-dedupe-refs-die-on-remount) precisely so a
  // remount cannot clear them — but that also means they no longer reset between test cases the way
  // the `useRef`s did. Without this, the second case to use a given fixture inherits the first's keys,
  // sees zero fresh events, and passes its "exactly once" assertion by asserting nothing at all.
  resetCoordinatorDedupe();
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

// #coordinator-dedupe-refs-die-on-remount — the once-each guards must outlive the MOUNT.
//
// THE BUG THIS PINS. Both guards were `useRef`s, and this hook is not mounted from a file:
// `useCoordinator()` is called from the `consolepage` graph RECORD, and `GraphComponent` remounts that
// page every time the record recompiles. Each recompile therefore handed the hook a fresh empty Set and
// it re-reported the whole tail. Measured over one app run: 28 `graph-loader: mounted "consolepage"`
// events, 28 bursts of the SAME 19 refusals, 532 warnings, bursts as little as nine seconds apart.
//
// WHY THE EXISTING COVERAGE MISSED IT, which is the part worth keeping: the case above asserts "not again
// when the same log is RE-READ", and a re-read keeps the ref alive. Only a REMOUNT replaces it. So every
// assertion here is about the second mount — the first was always correct, under both versions.
describe("useCoordinator — the dedupe guards outlive a remount", () => {
  const AT = "2026-08-12T15:09:25Z";
  const LATER = "2026-08-12T16:00:00Z";

  /** A blocked waiter whose dependency then FAILS — the smallest log that yields a push
   *  notification (`coordNotifications` reports a stalled waiter as `stalled:<session>`). */
  function stalledLog(): string[] {
    return [
      [AT, WORKER, "blocked", "#158"].join("	"),
      [AT, DIRECTOR, "failed", "#158", "build broke"].join("	"),
    ];
  }

  /** A paired phone. The file-level `vi.clearAllMocks()` wipes the module mock's resolved value, so the
   *  push path needs it restored per case; the default (`running: false`) short-circuits delivery. */
  function phonePaired(): void {
    vi.mocked(tunnelStatus).mockResolvedValue({
      running: true, relayUrl: "wss://relay.test", room: "r1", hostPubKey: "k", psk: "p",
      clientCount: 1, inputGranted: true,
    });
  }

  let warned: string[];
  let warnSpy: { mockRestore(): void };
  /** `setPaneMaintaining` is the hook's LAST synchronous step after the refusal loop, so its call count
   *  is the one honest "this read ran to completion" signal. */
  let maintainSpy: ReturnType<typeof vi.spyOn>;
  const refusalWarns = () => warned.filter((m) => m.includes("refused a cross-project"));

  /** Let the fire-and-forget push (`void pushNotifications(...)`) settle. It is kicked off AFTER the
   *  maintenance projection and awaits `tunnelStatus()`, so the completion signal above does not cover
   *  it, and unmounting mid-flight would hide a delivery rather than prove there was none. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }

  /** Mount, let one whole read complete, then unmount — one simulated `consolepage` recompile.
   *
   *  AWAITING THE INVOKE CALL IS NOT ENOUGH, and getting that wrong is how this suite first went green
   *  against the very bug it exists to catch. `invoke` is recorded when the read STARTS; unmounting there
   *  trips the hook's own `isCancelled()` guard, so the refusal loop never runs, no version warns, and
   *  "exactly one warning" passes for the wrong reason. Wait for a completed read instead. */
  async function mountCycle(): Promise<void> {
    const before = maintainSpy.mock.calls.length;
    const h = renderHook(() => useCoordinator());
    await waitFor(() => expect(maintainSpy.mock.calls.length).toBeGreaterThan(before));
    await settle();
    h.unmount();
  }

  function serveLog(lines: string[]): void {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "logs_tail" || cmd === "logs_coord") return Promise.resolve([...lines]);
      if (cmd.startsWith("logs_")) return Promise.resolve([]);
      return Promise.resolve(null);
    });
  }

  beforeEach(async () => {
    warned = [];
    vi.mocked(listen).mockImplementation(() => Promise.resolve(() => {}));
    warnSpy = vi.spyOn(log, "warn").mockImplementation((m: string) => { warned.push(m); });
    const { useAppStore } = await import("@/store");
    maintainSpy = vi.spyOn(useAppStore.getState(), "setPaneMaintaining");
  });

  afterEach(() => { warnSpy.mockRestore(); maintainSpy.mockRestore(); });

  it("the fixtures are REAL — one refuses, the other yields a push notification", async () => {
    // GUARD THE GUARD. Both assertions below are "still exactly one", which a fixture producing NOTHING
    // satisfies just as well — and would, silently, forever.
    const { coordNotifications } = await import("@/shared/lib/fleet/coordination");
    expect(ingestCoordLog([refusalLine(AT)]).refused).toHaveLength(1);
    const r = ingestCoordLog(stalledLog());
    expect(coordNotifications(r.state, r.ready).map((n) => n.key)).toEqual([`stalled:${WORKER}`]);
  });

  it("warns for a refusal ONCE ACROSS REMOUNTS, not once per mount", async () => {
    serveLog([refusalLine(AT)]);
    await mountCycle();
    expect(refusalWarns()).toHaveLength(1);

    // The ref-scoped version warns 19-at-a-time here, once per recompile, forever.
    await mountCycle();
    await mountCycle();
    expect(refusalWarns()).toHaveLength(1);
  });

  it("still warns for a NEW refusal after a remount — the guard is per event, not per process", async () => {
    // The fix must not over-suppress: surviving the mount is worthless if it also swallows the second,
    // genuinely newsworthy misdirection. `refusalKey` carries `at`, so a later attempt is a new key.
    const lines = [refusalLine(AT)];
    serveLog(lines);
    await mountCycle();
    expect(refusalWarns()).toHaveLength(1);

    lines.push(refusalLine(LATER));
    await mountCycle();
    expect(refusalWarns()).toHaveLength(2);
  });

  it("pushes a notification to the phone ONCE ACROSS REMOUNTS", async () => {
    // The worse half of the same bug, and the one with a consequence off the machine: the hook's own
    // comment promises each alert fires "exactly once (FCM is a push, not a poll)", and under the ref
    // every recompile re-delivered the current alert set to a paired phone.
    serveLog(stalledLog());
    phonePaired();
    await mountCycle();
    expect(vi.mocked(tunnelSetSessions)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tunnelSetSessions).mock.calls[0][0]).toMatchObject([{ paneId: WORKER }]);

    await mountCycle();
    await mountCycle();
    expect(vi.mocked(tunnelSetSessions)).toHaveBeenCalledTimes(1);
  });

  it("reads the guards THROUGH globalThis — module scope would NOT survive a graph recompile", async () => {
    // THE SECOND HALF OF THE BUG, and the one a remount test cannot see. In the app this hook is not the
    // bundled module: `resolveGraphSource` matches an algorithm impl by `provides`, and the
    // `use-coordinator.ts` record provides `@/app/console/useCoordinator` — so the loader vendors its
    // `code` into the consolepage closure and RE-EVALUATES it on every compile. A module-level `const Set`
    // is re-created exactly as often as the ref was, which fixes this vitest file (it imports the bundled
    // copy once, so module scope looks permanent here) and nothing in the running app.
    //
    // Deleting the registered symbol is what a re-evaluation does to a module-scoped guard, and it is the
    // only way this harness can tell the two apart: if the hook captured the Set in a module binding, the
    // deletion would be invisible and the report would stay suppressed.
    serveLog([refusalLine(AT)]);
    await mountCycle();
    expect(refusalWarns()).toHaveLength(1);

    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("bsc.coordinatorDedupe")];
    await mountCycle();
    expect(refusalWarns()).toHaveLength(2);
  });

  it("leaves an UNDELIVERED notification unmarked, so it still pushes once the phone pairs", async () => {
    // The `notified` Set is only written after a successful `tunnelSetSessions`. Hoisting it to module
    // scope must not turn "no phone paired" into a permanently swallowed alert.
    serveLog(stalledLog());
    vi.mocked(tunnelStatus).mockResolvedValue({
      running: false, relayUrl: null, room: null, hostPubKey: "", psk: "", clientCount: 0, inputGranted: false,
    });
    await mountCycle();
    expect(vi.mocked(tunnelSetSessions)).not.toHaveBeenCalled();

    phonePaired();
    await mountCycle();
    expect(vi.mocked(tunnelSetSessions)).toHaveBeenCalledTimes(1);
  });
});
