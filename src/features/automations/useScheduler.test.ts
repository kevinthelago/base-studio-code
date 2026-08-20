import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useScheduler, carriedSchedules, lastRunsFromLog } from "@/features/automations/useScheduler";
import { duePersonaSchedules } from "@/features/automations/lib/scheduler";
import { useAppStore } from "@/store";

// Mock the pure lib so tick cadence is assertable without real dispatch.
vi.mock("@/features/automations/lib/scheduler", async (orig) => ({
  ...(await orig<typeof import("@/features/automations/lib/scheduler")>()),
  duePersonaSchedules: vi.fn(() => []),
}));
vi.mock("@/features/automations/lib/dispatch", () => ({ dispatchSchedule: vi.fn() }));
vi.mock("@/shared/lib/core/logsBridge", () => ({ logsTail: vi.fn(async () => []) }));

describe("carriedSchedules", () => {
  const p = (id: string, schedules: unknown[]) => ({ id, schedules }) as never;

  it("flattens every persona's schedules, stamped with its carrier", () => {
    const out = carriedSchedules([
      p("p1", [{ name: "a", when: {}, command: "x" }]),
      p("p2", [{ name: "b", when: {}, command: "y" }, { name: "c", when: {}, command: "z" }]),
    ]);
    expect(out.map((c) => `${c.personaId}:${c.name}`)).toEqual(["p1:a", "p2:b", "p2:c"]);
  });

  it("ARMED DEFAULTS TO TRUE — only an explicit false disarms", () => {
    // A schedule written into a persona is meant to run; disarming is the explicit act. Defaulting
    // the other way would let a hand-authored persona silently carry a job that never fires.
    const out = carriedSchedules([p("p1", [
      { name: "on", when: {}, command: "x" },
      { name: "still-on", when: {}, command: "x", armed: true },
      { name: "off", when: {}, command: "x", armed: false },
    ])]);
    expect(out.map((c) => c.name)).toEqual(["on", "still-on"]);
  });

  it("skips a schedule that could never fire, rather than carrying a broken one", () => {
    const out = carriedSchedules([p("p1", [
      { name: "", when: {}, command: "x" },
      { name: "no-cmd", when: {}, command: "" },
      { name: "ok", when: {}, command: "x" },
    ])]);
    expect(out.map((c) => c.name)).toEqual(["ok"]);
  });

  it("tolerates a persona with no schedules field at all", () => {
    // `schedules` is optional — a persona authored before it existed must not throw.
    expect(carriedSchedules([{ id: "p1" } as never])).toEqual([]);
    expect(carriedSchedules([])).toEqual([]);
  });
});

describe("lastRunsFromLog", () => {
  const line = (ts: string, key: string) => `${ts}\tt0p1\t${key}\tok\tnote`;

  it("keeps the NEWEST fire per schedule", () => {
    const out = lastRunsFromLog([
      line("2026-08-20T10:00:00Z", "p1:gc"),
      line("2026-08-20T12:00:00Z", "p1:gc"),
      line("2026-08-20T11:00:00Z", "p1:gc"),
    ]);
    expect(out["p1:gc"]).toBe(Date.parse("2026-08-20T12:00:00Z"));
  });

  it("leaves a never-fired schedule ABSENT rather than zero", () => {
    // The distinction is load-bearing: `duePersonaSchedules` anchors an absent key forward, while a
    // 0 would read as decades overdue and fire the job the moment it was authored.
    const out = lastRunsFromLog([line("2026-08-20T10:00:00Z", "p1:gc")]);
    expect("p2:other" in out).toBe(false);
  });

  it("ignores malformed and unparseable lines instead of poisoning the map", () => {
    const out = lastRunsFromLog(["", "garbage", "not-a-date\tt0p1\tp1:gc\tok\t", line("2026-08-20T10:00:00Z", "p1:gc")]);
    expect(Object.keys(out)).toEqual(["p1:gc"]);
  });
});

describe("useScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(duePersonaSchedules).mockClear();
    // The tick returns before resolving anything when NO persona carries a schedule, so the store
    // needs one for the cadence to be observable at all.
    useAppStore.setState({
      personas: [{ id: "p1", name: "P", blurb: "", role: "worker", startPrompt: "", skills: [],
                   schedules: [{ name: "gc", when: { kind: "cron", expr: "0 2 * * *" }, command: "x" }] }] as never,
      panePersonas: {}, disabledPanes: {},
    });
  });
  afterEach(() => vi.useRealTimers());

  it("does NOT check immediately — the first tick is the ~1s hydration grace", async () => {
    renderHook(() => useScheduler());
    expect(duePersonaSchedules).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(duePersonaSchedules).toHaveBeenCalledTimes(1); // grace tick
  });

  // ASYNC timer advance, deliberately: the tick is async, and usePoll skips a tick while the
  // previous run is still in flight (#3666, so slow runs cannot stack). The sync
  // `advanceTimersByTime` never flushes the microtask queue, so that in-flight promise would never
  // settle and the SECOND interval tick would be (correctly) suppressed — an artifact of the fake
  // clock, not of the scheduler.
  it("then checks on the 20s interval", async () => {
    renderHook(() => useScheduler());
    await vi.advanceTimersByTimeAsync(1000);
    expect(duePersonaSchedules).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(duePersonaSchedules).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(duePersonaSchedules).toHaveBeenCalledTimes(3);
  });

  it("stops ticking after unmount", async () => {
    const { unmount } = renderHook(() => useScheduler());
    await vi.advanceTimersByTimeAsync(1000);
    expect(duePersonaSchedules).toHaveBeenCalledTimes(1);
    unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(duePersonaSchedules).toHaveBeenCalledTimes(1); // no further ticks
  });

  it("does not even read the log when no persona carries a schedule", async () => {
    // The common case by far. Reading a log every 20s to discover there is nothing to run is pure
    // cost on every install that has never authored one.
    useAppStore.setState({ personas: [] as never });
    renderHook(() => useScheduler());
    await vi.advanceTimersByTimeAsync(1000);
    expect(duePersonaSchedules).not.toHaveBeenCalled();
  });
});
