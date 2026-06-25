import { describe, it, expect } from "vitest";
import { isTurnOpen, paneActivityFor, type PaneActivity } from "./paneActivity";

// The status-dot gate (#1184): the silence timer must NOT idle a pane whose turn is still open
// (a UserPromptSubmit with no following Stop). These tests pin the pure decision the poller feeds
// into TerminalView's `armQuietTimer` callback.

describe("isTurnOpen — silence-timer gate", () => {
  it("treats a run state as turn-open (gates the silence timer)", () => {
    // A worker that submitted a prompt and is now working-but-silent (thinking / long tool call /
    // backoff) records `run` — the dot must stay run past QUIET_MS instead of false-idling.
    expect(isTurnOpen({ pane: "p1", state: "run", at: 100 })).toBe(true);
  });

  it("treats an idle state as turn-closed (silence timer stays authoritative)", () => {
    // An authoritative Stop records `idle` — the gate releases, so the pane idles.
    expect(isTurnOpen({ pane: "p1", state: "idle", at: 200 })).toBe(false);
  });

  it("treats no activity as NOT turn-open — no regression for non-bash / never-launched panes", () => {
    // A PowerShell/cmd session or a pane that hasn't taken a turn emits no activity at all; the gate
    // stays false so the silence timer behaves exactly as before.
    expect(isTurnOpen(undefined)).toBe(false);
  });
});

describe("paneActivityFor — per-pane lookup", () => {
  const rows: PaneActivity[] = [
    { pane: "t0p0", state: "idle", at: 10 },
    { pane: "t0p1", state: "run", at: 20 },
  ];

  it("picks this pane's record out of the flat list", () => {
    expect(paneActivityFor(rows, "t0p1")).toEqual({ pane: "t0p1", state: "run", at: 20 });
    // End-to-end: an open turn for t0p1 gates its timer; a closed turn for t0p0 does not.
    expect(isTurnOpen(paneActivityFor(rows, "t0p1"))).toBe(true);
    expect(isTurnOpen(paneActivityFor(rows, "t0p0"))).toBe(false);
  });

  it("returns undefined for a pane with no activity row (and for an empty/undefined list)", () => {
    expect(paneActivityFor(rows, "t0p9")).toBeUndefined();
    expect(paneActivityFor([], "t0p1")).toBeUndefined();
    expect(paneActivityFor(undefined, "t0p1")).toBeUndefined();
  });
});
