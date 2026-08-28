// #4101 — the wake decision. The verdict matters more than the happy path: a false reported as success
// leaves a dead worker (#4025). And the KILL matters as much as the verdict: without it a pane whose
// shell outlived its agent reconnects instead of spawning, so the wake lands nowhere while reporting
// success (#wake-restarts-a-pane-whose-shell-outlived-claude).
import { describe, it, expect, vi } from "vitest";
import { applyWake, DEFAULT_WAKE_PROMPT } from "@/app/fleetWakeBridge";

/** Deps with a recording kill, defaulting to a wake that lands. */
function deps(over: { wakePane?: (p: string, t: string) => boolean; killPane?: (p: string) => Promise<void> } = {}) {
  const calls: string[] = [];
  const killPane = over.killPane ?? (async (p: string) => { calls.push(`kill:${p}`); });
  const inner = over.wakePane ?? (() => true);
  const wakePane = vi.fn((p: string, t: string) => { calls.push(`wake:${p}`); return inner(p, t); });
  return { d: { wakePane, killPane }, wakePane, calls };
}

describe("applyWake", () => {
  it("wakes the pane and reports the verdict", async () => {
    const { d, wakePane } = deps();
    expect(await applyWake("r1", { paneId: "proj:api", prompt: "rebase onto develop" }, d)).toEqual({
      id: "r1",
      woke: true,
    });
    expect(wakePane).toHaveBeenCalledWith("proj:api", "rebase onto develop", undefined);
  });

  it("supplies the standard wake prompt when the caller gives none", async () => {
    const { d, wakePane } = deps();
    await applyWake("r2", { paneId: "proj:api" }, d);
    expect(wakePane).toHaveBeenCalledWith("proj:api", DEFAULT_WAKE_PROMPT, undefined);
    // A whitespace-only prompt is the same as none — otherwise the worker wakes to a blank task.
    await applyWake("r3", { paneId: "proj:api", prompt: "   " }, d);
    expect(wakePane).toHaveBeenLastCalledWith("proj:api", DEFAULT_WAKE_PROMPT, undefined);
  });

  it("carries a FALSE verdict through instead of reporting success", async () => {
    // The #4025 shape: wakePane cannot resolve the pane, so nothing was woken — but the kill already
    // happened. Reporting `woke: true` here is what made that bug silent.
    const { d } = deps({ wakePane: () => false });
    expect((await applyWake("r4", { paneId: "ghost" }, d)).woke).toBe(false);
  });

  it("rejects an empty pane id without touching the store", async () => {
    const { d, wakePane, calls } = deps();
    const ack = await applyWake("r5", { paneId: "  " }, d);
    expect(ack.woke).toBe(false);
    expect(ack.error).toMatch(/no pane id/);
    expect(wakePane).not.toHaveBeenCalled();
    expect(calls).toEqual([]); // and nothing was killed either
  });

  // ── The regression this item exists for ──────────────────────────────────────────────────────────
  //
  // A pane whose SHELL is alive but whose agent has exited (`live && !busy` in `bsc fleet list`) used
  // to reconnect: `wakePane` only bumps `runId`, and `pty_create` reconnects rather than spawning when
  // a PTY already exists, discarding the baked prompt. Claude never started and `woke: true` was
  // returned anyway.
  it("KILLS the PTY before waking, so the remount spawns instead of reconnecting", async () => {
    const { d, calls } = deps();
    await applyWake("r6", { paneId: "proj:api" }, d);
    expect(calls).toEqual(["kill:proj:api", "wake:proj:api"]);
  });

  it("still wakes when there is nothing to kill (a dormant/reaped pane)", async () => {
    // `pty_kill` on an absent session rejects. Aborting there would break the case the command was
    // built for — a reaped worker is precisely the one with no PTY.
    const { d, wakePane } = deps({ killPane: () => Promise.reject(new Error("no such session")) });
    const ack = await applyWake("r7", { paneId: "proj:reaped" }, d);
    expect(ack.woke).toBe(true);
    expect(wakePane).toHaveBeenCalledWith("proj:reaped", DEFAULT_WAKE_PROMPT, undefined);
  });

  it("does not report success when the kill succeeded but the wake found no tab", async () => {
    // Both halves must hold: killing is not evidence of waking.
    const { d } = deps({ wakePane: () => false });
    expect((await applyWake("r8", { paneId: "proj:orphan" }, d)).woke).toBe(false);
  });
  // ── STARTING a stream that never launched (#the-director-cannot-start-a-stream-that-never-launched) ──
  //
  // The store cannot read plan.db, so a stream it has never seen is startable ONLY because Rust resolved
  // the row and sent it. This bridge is the conduit, and a conduit that drops its payload fails silently:
  // `wakePane` would refuse exactly as before and the director would be told the pane resolved to no tab.
  it("hands the plan row straight through to wakePane", async () => {
    const { d, wakePane } = deps();
    const stream = { id: "api", name: "API", repo: "own/api", owns: [], issues: [], dependsOn: [], cwd: "/wt/api" };
    await applyWake("r9", { paneId: "proj:api", prompt: "start on #7", stream }, d);
    expect(wakePane).toHaveBeenCalledWith("proj:api", "start on #7", stream);
  });

  it("passes NOTHING when Rust resolved nothing — the refusal must stay reachable", async () => {
    // Absence is meaningful in both directions: a live pane never needed a lookup, and a not-live pane
    // whose stream plan.db does not name gets none. Forwarding a placeholder would turn an unknown
    // stream into a started one.
    const { d, wakePane } = deps();
    await applyWake("r10", { paneId: "proj:ghost" }, d);
    expect(wakePane).toHaveBeenCalledWith("proj:ghost", DEFAULT_WAKE_PROMPT, undefined);
  });
});

describe("a refusal names its condition", () => {
  // The generic sentence — "it resolved to no open tab, or is disabled" — is already recorded in
  // `fleet/wake.rs` as having "sent three rounds of debugging at the frontend for a repo that was
  // simply not cloned". It did it again: a pane left DISABLED by an End session read as a missing
  // tab, twice. Rust returns `ack.error` verbatim when present, so naming the condition is the fix.
  const base = { killPane: async () => {}, wakePane: () => false };

  it("passes the frontend's reason through when the wake is refused", async () => {
    const ack = await applyWake("w1", { paneId: "proj:worker" } as never, {
      ...base,
      refusalReason: (p: string) => `'${p}' is DISABLED — re-enable it in the Console`,
    } as never);
    expect(ack.woke).toBe(false);
    expect(ack.error).toContain("DISABLED");
    expect(ack.error).toContain("proj:worker");
  });

  it("says nothing specific when there is nothing specific to say", async () => {
    const ack = await applyWake("w2", { paneId: "proj:worker" } as never, { ...base } as never);
    expect(ack.woke).toBe(false);
    expect(ack.error).toBeUndefined();   // Rust falls back to its own sentence
  });

  it("carries no reason when the wake LANDS — a reason would read as a failure", async () => {
    const ack = await applyWake("w3", { paneId: "proj:worker" } as never, {
      killPane: async () => {},
      wakePane: () => true,
      refusalReason: () => "must not be used",
    } as never);
    expect(ack.woke).toBe(true);
    expect(ack.error).toBeUndefined();
  });
});
