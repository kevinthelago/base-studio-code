// personaUseBridge (#change-a-panes-persona-from-the-cli) — the pure decision behind `bsc persona use`.
//
// The listener is a thin adapter, so everything worth pinning is here: that an unknown persona is
// refused before anything is killed, that the relaunch is kill-then-wake in that order, and that the ack
// distinguishes "the assignment landed" from "the session came back".
import { describe, it, expect, vi } from "vitest";
import {
  applyPersonaUse,
  PERSONA_CHANGE_PROMPT,
  type PersonaUseDeps,
} from "@/app/personaUseBridge";

/** A deps double that records the ORDER of the calls, which is the part that is load-bearing. */
function deps(over: Partial<PersonaUseDeps> = {}) {
  const order: string[] = [];
  const base: PersonaUseDeps = {
    personaIds: () => ["worker", "reviewer"],
    currentPersona: () => "worker",
    setPanePersona: vi.fn(() => { order.push("set"); }),
    killPane: vi.fn(async () => { order.push("kill"); }),
    wakePane: vi.fn(() => { order.push("wake"); return true; }),
    ...over,
  };
  return { deps: base, order };
}

const REQ = { paneId: "demo:worker", personaId: "reviewer", relaunch: true };

describe("applyPersonaUse", () => {
  it("sets the persona, relaunches, and reports what it replaced", async () => {
    const { deps: d } = deps();
    const ack = await applyPersonaUse("r1", REQ, d);
    expect(ack).toEqual({ id: "r1", applied: true, previous: "worker", relaunched: true });
    expect(d.setPanePersona).toHaveBeenCalledWith("demo:worker", "reviewer");
    expect(d.wakePane).toHaveBeenCalledWith("demo:worker", PERSONA_CHANGE_PROMPT);
  });

  it("kills BEFORE it wakes — reversed, the remount reconnects instead of spawning", async () => {
    const { deps: d, order } = deps();
    await applyPersonaUse("r1", REQ, d);
    expect(order).toEqual(["set", "kill", "wake"]);
  });

  it("refuses an unknown persona WITHOUT killing anything, and names the ones that exist", async () => {
    const { deps: d } = deps();
    const ack = await applyPersonaUse("r1", { ...REQ, personaId: "nope" }, d);
    expect(ack.applied).toBe(false);
    expect(ack.error).toContain("nope");
    expect(ack.error, "a caller that typo'd should not have to run a second command").toContain("reviewer");
    expect(d.killPane, "nothing may be killed on the way to an error").not.toHaveBeenCalled();
    expect(d.setPanePersona).not.toHaveBeenCalled();
  });

  it("--no-relaunch stages the assignment and leaves the session alone", async () => {
    const { deps: d } = deps();
    const ack = await applyPersonaUse("r1", { ...REQ, relaunch: false }, d);
    expect(ack).toEqual({ id: "r1", applied: true, previous: "worker", relaunched: false });
    expect(d.killPane).not.toHaveBeenCalled();
    expect(d.wakePane).not.toHaveBeenCalled();
  });

  it("reports applied:true / relaunched:false when the pane resolves to no tab", async () => {
    // The assignment DID land; only the session did not come back. Collapsing the two would either
    // hide a real change or report a total failure for a partial one.
    const { deps: d } = deps({ wakePane: vi.fn(() => false) });
    const ack = await applyPersonaUse("r1", REQ, d);
    expect(ack.applied).toBe(true);
    expect(ack.relaunched).toBe(false);
  });

  it("a kill that throws does not abort the relaunch", async () => {
    // The usual reason is that there was nothing to kill — a dormant pane is exactly where changing a
    // persona is cheapest, so refusing there would break the best case.
    const { deps: d } = deps({ killPane: vi.fn(async () => { throw new Error("no such session"); }) });
    const ack = await applyPersonaUse("r1", REQ, d);
    expect(ack.relaunched).toBe(true);
  });

  it("carries previous:undefined for a pane that had no persona", async () => {
    const { deps: d } = deps({ currentPersona: () => undefined });
    const ack = await applyPersonaUse("r1", REQ, d);
    expect(ack.previous).toBeUndefined();
    expect(ack.applied).toBe(true);
  });

  it("refuses an empty pane id or persona id rather than acting on a blank", async () => {
    const { deps: d } = deps();
    expect((await applyPersonaUse("r1", { ...REQ, paneId: "  " }, d)).error).toContain("no pane id");
    expect((await applyPersonaUse("r1", { ...REQ, personaId: "" }, d)).error).toContain("no persona id");
    expect(d.setPanePersona).not.toHaveBeenCalled();
  });

  it("a throwing DEP is the adapter's job, not this one's — the boundary, stated", async () => {
    // `applyPersonaUse` is total over its OWN paths (bad input, unknown persona, a kill that fails).
    // A dep that throws propagates on purpose: swallowing it here would hide a real bug, and the
    // listener already wraps the call so the Rust waiter still gets an ack.
    const { deps: d } = deps({ personaIds: () => { throw new Error("store exploded"); } });
    await expect(applyPersonaUse("r1", REQ, d)).rejects.toThrow("store exploded");
  });
});
