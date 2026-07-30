import { describe, it, expect } from "vitest";
import { isTurnOpen, isTurnOpenDebounced, ACTIVITY_IDLE_GRACE_MS, paneActivityFor, type PaneActivity, needsAttention } from "./paneActivity";

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

describe("isTurnOpenDebounced — worker flicker debounce", () => {
  const NOW = 100_000;

  it("keeps run open regardless of time", () => {
    expect(isTurnOpenDebounced({ pane: "p1", state: "run", at: 0 }, NOW)).toBe(true);
  });

  it("keeps a freshly-idle turn open within the grace window (no blink)", () => {
    // A worker's blocked Stop just recorded idle; its next prompt is about to reopen run. The dot
    // must NOT blink idle in this gap.
    expect(isTurnOpenDebounced({ pane: "p1", state: "idle", at: NOW - 1000 }, NOW)).toBe(true);
    expect(isTurnOpenDebounced({ pane: "p1", state: "idle", at: NOW - (ACTIVITY_IDLE_GRACE_MS - 1) }, NOW)).toBe(true);
  });

  it("releases the gate once idle is older than the grace (genuinely done)", () => {
    expect(isTurnOpenDebounced({ pane: "p1", state: "idle", at: NOW - ACTIVITY_IDLE_GRACE_MS }, NOW)).toBe(false);
    expect(isTurnOpenDebounced({ pane: "p1", state: "idle", at: NOW - 10_000 }, NOW)).toBe(false);
  });

  it("treats no activity as not open (non-bash fallback unchanged)", () => {
    expect(isTurnOpenDebounced(undefined, NOW)).toBe(false);
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

describe("needsAttention (#4005)", () => {
  const act = (state: "run" | "idle" | "attn", at = 0) => ({ pane: "p", state, at });

  it("is true only for attn", () => {
    expect(needsAttention(act("attn"))).toBe(true);
    expect(needsAttention(act("run"))).toBe(false);
    expect(needsAttention(act("idle"))).toBe(false);
    expect(needsAttention(undefined)).toBe(false);
  });

  it("does NOT make the turn read as open", () => {
    // An `attn` pane is STOPPED, not working. Treating it as turn-open would hold the status dot at
    // "run" for a session that is doing nothing — the exact wrongful-run the #1184 gate exists to
    // avoid, just from the other direction. This adds a signal; it must not re-gate the old one.
    expect(isTurnOpen(act("attn"))).toBe(false);
    expect(isTurnOpenDebounced(act("attn"), 10_000)).toBe(false);
  });

  it("is cleared by the ordinary turn boundaries", () => {
    // The Notification hook only fires; nothing un-fires it. Clearing is the next UserPromptSubmit
    // (`run`) or Stop (`idle`) superseding the row — without that a pane stays flagged forever after
    // a single permission prompt.
    expect(needsAttention(act("run"))).toBe(false);
    expect(needsAttention(act("idle"))).toBe(false);
  });
});
