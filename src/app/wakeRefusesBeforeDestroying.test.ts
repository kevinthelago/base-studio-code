// A wake must not destroy a session it cannot bring back —
// `a-wake-kills-a-pane-it-cannot-relaunch-and-reports-success`.
//
// WHY THIS FILE IS SEPARATE FROM THE RECORD'S CARRIED TEST. `fleetWakeBridge` is a record, and a
// record's carried test can only be written by `bsc graph tests harvest`, which pairs by COLOCATED
// FILE — and this module's file was retired, so its test is frozen at whatever it was when the file
// last existed (filed as `bsc request` 138). If that gap closes, fold these back onto the record.
//
// THE BUG, measured on the live network-monitor fleet. The director woke sessions with a prompt and
// they all shut down. Three links:
//
//   1. `applyWake` kills the PTY FIRST, unconditionally — deliberately, because without it the
//      remount reconnects to a live shell and the baked prompt is silently discarded.
//   2. `wakePane`'s verdict answers ONE question: could an owning tab and a grid seat be resolved.
//      It never asks whether the relaunch can succeed.
//   3. `pty_create` then REFUSES a project-identity pane whose cwd has no `.claude/settings.json`
//      (`must_be_gated` + the #1819 guard). That refusal is correct — an ungated director or worker
//      is worse than none — but it lands AFTER the frontend has acked `woke: true`.
//
// Four worktrees were in that state (host-operations-adapter, nac-and-freeradius-adapter,
// omada-controller-adapter, opnsense-config-adapter): complete except for `.claude/`. Waking any of
// them destroyed a live session, got refused, and reported success. The command's own help already
// warned about the shape — "the wake path kills first, so a false success would leave a dead worker
// behind a caller that believes it is running" — there was simply no way to ask in advance.
import { describe, it, expect, vi } from "vitest";
import { applyWake } from "@/app/fleetWakeBridge";

/** Deps with a recording kill, defaulting to a wake that lands — mirrors the record's own helper. */
function deps(over: { wakePane?: () => boolean } = {}) {
  const calls: string[] = [];
  const killPane = async (p: string) => { calls.push(`kill:${p}`); };
  const inner = over.wakePane ?? (() => true);
  const wakePane = vi.fn((p: string) => { calls.push(`wake:${p}`); return inner(); });
  return { d: { wakePane, killPane }, wakePane, calls };
}

const REFUSAL =
  "pty[proj:api] refusing to auto-launch claude at /wt/api — no .claude/settings.json, so the role " +
  "gate and shell allowlist were never written and the session would run permission-less (#1819).";

describe("a wake does not destroy a session it cannot bring back", () => {
  it("REFUSES without killing when the launch would be refused", async () => {
    const { d, wakePane, calls } = deps();
    const ack = await applyWake("g1", { paneId: "proj:api" }, {
      ...d,
      launchRefusal: async () => REFUSAL,
    } as never);

    expect(ack.woke).toBe(false);
    // The launch's OWN words, not a generic sentence. `fleet/wake.rs` records that the generic
    // refusal "sent three rounds of debugging at the frontend for a repo that was simply not cloned".
    expect(ack.error).toBe(REFUSAL);
    expect(calls).toEqual([]);                // NOTHING was killed — the whole point
    expect(wakePane).not.toHaveBeenCalled();  // ...and nothing was woken either
  });

  it("proceeds normally, in order, when the launch would be admitted", async () => {
    const { d, calls } = deps();
    const ack = await applyWake("g2", { paneId: "proj:api" }, {
      ...d,
      launchRefusal: async () => undefined,
    } as never);
    expect(ack.woke).toBe(true);
    // Kill still precedes wake — the pre-check must not have reordered the load-bearing part.
    expect(calls).toEqual(["kill:proj:api", "wake:proj:api"]);
  });

  it("does not refuse the wake when the pre-check itself fails", async () => {
    // A guard, not a gate on the app being healthy. If asking throws — command missing, backend
    // mid-restart — fall back to the previous behaviour: this fixes killing a pane we KNOW cannot
    // relaunch, not refusing whenever we are unsure. Failing closed here would make a backend hiccup
    // look exactly like a broken worktree.
    const { d, calls } = deps();
    const ack = await applyWake("g3", { paneId: "proj:api" }, {
      ...d,
      launchRefusal: () => Promise.reject(new Error("no such command")),
    } as never);
    expect(ack.woke).toBe(true);
    expect(calls).toEqual(["kill:proj:api", "wake:proj:api"]);
  });

  it("behaves exactly as before when no pre-check is wired at all", async () => {
    // The dep is optional so an older caller — or a test that does not care — is unchanged.
    const { d, calls } = deps();
    expect((await applyWake("g4", { paneId: "proj:api" }, d as never)).woke).toBe(true);
    expect(calls).toEqual(["kill:proj:api", "wake:proj:api"]);
  });

  it("still reports a store-side refusal, which is a different condition", async () => {
    // The pre-check covers "the launch will refuse". `wakePane` returning false covers "no open tab,
    // or disabled". Both must stay reachable and distinguishable — collapsing them is what produced
    // the one-sentence refusal that listed every possible cause.
    const { d } = deps({ wakePane: () => false });
    const ack = await applyWake("g5", { paneId: "proj:orphan" }, {
      ...d,
      launchRefusal: async () => undefined,
      refusalReason: () => "'proj:orphan' is DISABLED — re-enable it in the Console",
    } as never);
    expect(ack.woke).toBe(false);
    expect(ack.error).toContain("DISABLED");
  });
});
