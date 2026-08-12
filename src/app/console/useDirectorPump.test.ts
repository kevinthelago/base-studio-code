// #idle-reminder-stops-nagging-the-director — the idle reminder must not fire.
//
// #4019 added a rate-limited backstop: while a director pane was IDLE with anything outstanding, the
// pump re-stated the queue every ASK_REMINDER_MS (3 min). The flaw is in what "outstanding" meant — an
// ask is only cleared by an `answer`/`assign` targeting that session, or by a later event FROM it, so
// nothing clears an ask whose session has DIED. A dead worker's question stayed pending forever and
// the director was woken about it every 3 minutes, indefinitely, to drain a queue it could not drain.
//
// The guard here is deliberately TIME-BASED rather than "does the code import shouldRemind": the
// regression that matters is the reminder firing again, and only advancing the clock past the window
// can see it. A test that merely ticked the pump twice would pass against the OLD code too, because
// the rate limit alone would have suppressed the second injection.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store";
import { useDirectorPump } from "./useDirectorPump";
import { ASK_REMINDER_MS } from "@/features/planner";

// The pump re-ticks on the `logs://coord` change event (useLogStream, #3638) — NOT on a re-render.
// Capturing that handler is the only way to drive a second tick, and driving a second tick is the
// only way this test can see the reminder. Verified by restoring the reminder and watching it fail.
const handlers: Record<string, () => void> = {};

const DIRECTOR = "demo:director";
const WORKER = "demo:api";

/** One tab-separated coord.log row, the shape `parseCoordLine` reads. */
const line = (at: string, session: string, kind: string, arg = "", body = "") =>
  [at, session, kind, arg, body].join("\t");

/** Every `pty_write` payload aimed at a pane, in order. */
const writesTo = (paneId: string) =>
  vi.mocked(invoke).mock.calls
    .filter(([c, a]) => c === "pty_write" && (a as { paneId: string }).paneId === paneId)
    .map(([, a]) => (a as { data: string }).data);

/** The pump only injects PROSE via the bracketed-paste payload; ESC/CR are framing, not messages. */
const messagesTo = (paneId: string) => writesTo(paneId).filter((d) => d.includes("[coordinator]"));

const statusRef = { current: { [DIRECTOR]: "idle" as const, [WORKER]: "idle" as const } };

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(handlers)) delete handlers[k];
  vi.mocked(listen).mockImplementation((name, cb) => {
    handlers[name] = () => (cb as (e: { payload: unknown }) => void)({ payload: null });
    return Promise.resolve(() => {});
  });
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    // A worker asked a question and NOTHING ever cleared it — the session is gone. This is exactly
    // the row that drove the forever-nag.
    if (cmd === "logs_tail") {
      return Promise.resolve([line("2026-07-30T10:00:00Z", WORKER, "ask", "which base branch?")]);
    }
    return Promise.resolve(undefined);
  });
  useAppStore.setState({
    paneRoles: { [DIRECTOR]: "director", [WORKER]: "worker" },
    // `event` is the DEFAULT drive and the one the reminder was added for — an event director has no
    // heartbeat, so it is precisely the case that went silent and got the backstop.
    paneDirectorDrive: { [DIRECTOR]: "event" },
  } as never);
});

afterEach(() => { vi.useRealTimers(); });

describe("useDirectorPump — the idle reminder is disabled", () => {
  it("delivers a pending ask ONCE and never re-states it, however long the director sits idle", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-30T12:00:00Z"));

    renderHook(() => useDirectorPump(statusRef));

    // The immediate, once-per-ask delivery is UNCHANGED and must still happen — that is the path a
    // worker's question actually reaches the director by.
    await waitFor(() => expect(messagesTo(DIRECTOR).length).toBe(1));
    await waitFor(() => expect(handlers["logs://coord"]).toBeTypeOf("function"));

    // Now sit idle well past the reminder window, several times over, ticking the pump each time via
    // the real change event. Under #4019 each crossing produced another "you are idle and this is
    // still outstanding" injection about the same, permanently-unclearable ask.
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + ASK_REMINDER_MS * 2);
      handlers["logs://coord"]();
      await vi.waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(
      messagesTo(DIRECTOR),
      "an idle director must be re-prompted zero times — resuming it is the user's click",
    ).toHaveLength(1);
  });

  it("keeps the reminder helpers exported, so re-enabling is a restored call not a rewrite", async () => {
    // The item asks for DISABLED, not deleted. Pin that the pure core survives: if someone removes
    // these while "cleaning up", turning the backstop back on becomes a re-implementation.
    const planner = await import("@/features/planner");
    expect(typeof planner.shouldRemind).toBe("function");
    expect(typeof planner.idleReminderPrompt).toBe("function");
    expect(typeof planner.ASK_REMINDER_MS).toBe("number");
  });
});
