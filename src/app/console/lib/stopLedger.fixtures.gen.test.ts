// The stop ledger, captured from the LIVE TypeScript so the Rust port can be proved equal.
//
// Rust already supplies every FACT this reasons over: `console/pty/pump.rs` emits `pty_exit_<pane>`
// knowing the exit code, the signal and whether the cage launcher died before the agent ran; it phrases
// the `detail`; it sanitizes the last output. What ran here is the JUDGEMENT on those facts.
//
// THE JUDGEMENT IS THE POINT. The routine/fault split is what stops the feature becoming noise — every
// session ends eventually, so a banner firing on all of them is one the user learns to ignore, and the
// real failures hide among them. `finished` is a SUCCESS.
//
//     UPDATE_FIXTURES=1 npx vitest run src/app/console/lib/stopLedger.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  isFaultStop, recordStop, activeStops, stopLogLine, STOP_NOTICE_MS, MAX_STOPS,
} from "@/app/console/lib/paneStops";
import type { PaneStop, StopReason } from "@/app/console/lib/paneStops";

const FIXTURE = join(process.cwd(), "src/app/console/lib/stopLedger.fixtures.json");

const REASONS: StopReason[] = [
  "finished", "failed", "signalled", "launcher-failed", "app-closed",
  "unknown", "reaped", "auto-ended", "quarantined", "disabled",
];

const stop = (paneId: string, reason: StopReason, at: number, lastOutput?: string): PaneStop =>
  ({ paneId, reason, detail: `detail for ${reason}`, at, ...(lastOutput !== undefined ? { lastOutput } : {}) });

/** Ledger scenarios, each `now`-relative so expiry is exact rather than wall-clock. */
type Case = { label: string; existing: PaneStop[]; incoming: PaneStop; now: number };

const T = 1_000_000;
const SUBJECTS: Case[] = [
  { label: "an empty ledger", existing: [], incoming: stop("p1", "failed", T), now: T },
  { label: "a second pane stops", existing: [stop("p1", "failed", T)], incoming: stop("p2", "signalled", T), now: T },
  // REPLACE, don't stack — the nine-stops-in-one-run case.
  { label: "the SAME pane stops again — replaced, not stacked", existing: [stop("p1", "failed", T)], incoming: stop("p1", "signalled", T + 100), now: T + 100 },
  { label: "the same pane stops nine times", existing: Array.from({ length: 8 }, (_, i) => stop("p1", "failed", T + i)), incoming: stop("p1", "signalled", T + 8), now: T + 8 },
  // Expiry.
  { label: "an EXPIRED stop is dropped on the next record", existing: [stop("old", "failed", T - STOP_NOTICE_MS - 1)], incoming: stop("p1", "failed", T), now: T },
  { label: "a stop exactly AT the window edge is expired", existing: [stop("old", "failed", T - STOP_NOTICE_MS)], incoming: stop("p1", "failed", T), now: T },
  { label: "a stop just INSIDE the window survives", existing: [stop("old", "failed", T - STOP_NOTICE_MS + 1)], incoming: stop("p1", "failed", T), now: T },
  // The cap.
  { label: "the ledger is capped", existing: Array.from({ length: MAX_STOPS + 4 }, (_, i) => stop(`pane${i}`, "failed", T)), incoming: stop("new", "failed", T), now: T },
];

describe("stopLedger fixtures", () => {
  it("captures the judgement, the ledger and the log line", () => {
    const next = {
      note: "GENERATED from @/app/console/lib/paneStops — do not hand-edit; see the .gen.test.ts",
      noticeMs: STOP_NOTICE_MS,
      maxStops: MAX_STOPS,
      // Every reason: is it a fault, and what does its log line read like with and without output?
      reasons: REASONS.map((r) => ({
        reason: r,
        fault: isFaultStop(r),
        logWithOutput: stopLogLine(stop("p1", r, T, "the last words")),
        logWithoutOutput: stopLogLine(stop("p1", r, T)),
      })),
      cases: SUBJECTS.map((c) => {
        const after = recordStop(c.existing, c.incoming, c.now);
        return {
          label: c.label,
          existing: c.existing,
          incoming: c.incoming,
          now: c.now,
          after,
          active: activeStops(after, c.now),
        };
      }),
    };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("`finished` is a SUCCESS, and the routine set is exactly five", () => {
    expect(isFaultStop("finished"), "a completed agent is not a fault").toBe(false);
    const routine = REASONS.filter((r) => !isFaultStop(r));
    expect(routine.sort()).toEqual(["app-closed", "auto-ended", "disabled", "finished", "reaped"]);
    expect(REASONS.filter(isFaultStop).sort()).toEqual(["failed", "launcher-failed", "quarantined", "signalled", "unknown"]);
  });

  it("REPLACE, don't stack — nine stops for one pane leave one notice", () => {
    let list: PaneStop[] = [];
    for (let i = 0; i < 9; i++) list = recordStop(list, stop("p1", "failed", T + i), T + i);
    expect(list.filter((s) => s.paneId === "p1")).toHaveLength(1);
    expect(list[list.length - 1].at, "the NEWEST answer is the one kept").toBe(T + 8);
  });

  it("only a FAULT carries its last output into the log line", () => {
    expect(stopLogLine(stop("p1", "finished", T, "chatter")), "quoting a clean session is noise")
      .not.toContain("last output");
    expect(stopLogLine(stop("p1", "signalled", T, "chatter"))).toContain("last output: chatter");
  });

  it("a fault that printed NOTHING says so rather than leaving an absence", () => {
    expect(stopLogLine(stop("p1", "signalled", T))).toContain("(printed nothing)");
  });
});
