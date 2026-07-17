import { describe, it, expect } from "vitest";
import type { OpenCommission } from "./coordination.types";
import {
  activeTargets, authorInjections, deliverBackInjections, authorTaskPrompt,
  deliverBackPrompt, isStudioTarget, isOpen, STUDIO_PANE,
} from "./studioNetworkDrive";
import {
  DESIGN_STUDIO_SESSION_ID, ALGORITHMS_STUDIO_SESSION_ID,
} from "@/shared/lib/session/systemSessions";

const c = (over: Partial<OpenCommission>): OpenCommission => ({
  id: "planner@1", from: "planner:p0", target: "designer", body: "a heatmap", at: 1, ...over,
});

describe("studioNetworkDrive — targets + open/closed", () => {
  it("isStudioTarget accepts designer/librarian, rejects others", () => {
    expect(isStudioTarget("designer")).toBe(true);
    expect(isStudioTarget("librarian")).toBe(true);
    expect(isStudioTarget("director")).toBe(false);
    expect(isStudioTarget("planner")).toBe(false);
  });

  it("isOpen is false once delivered is set", () => {
    expect(isOpen(c({}))).toBe(true);
    expect(isOpen(c({ delivered: "react-d3:heatmap" }))).toBe(false);
  });

  it("activeTargets = distinct OPEN targets, ignoring delivered + unknown targets", () => {
    const list = [
      c({ id: "a", target: "designer" }),
      c({ id: "b", target: "librarian" }),
      c({ id: "c", target: "designer" }),                      // dup target → once
      c({ id: "d", target: "designer", delivered: "x:y" }),    // delivered → not active
      c({ id: "e", target: "director" }),                       // not a studio → ignored
    ];
    expect(activeTargets(list)).toEqual(["designer", "librarian"]);
  });
});

describe("studioNetworkDrive — author-task injections (settle-gated, once)", () => {
  it("waits for the settle window before injecting into a freshly-active target", () => {
    const list = [c({ id: "planner@1", target: "designer" })];
    const activatedAt = { designer: 1000 };
    // Not yet settled (2s < 3s) → nothing.
    expect(authorInjections(list, activatedAt, 3000, 3000, new Set())).toEqual([]);
    // Settled → one injection into the DESIGNER pane.
    const due = authorInjections(list, activatedAt, 4000, 3000, new Set());
    expect(due).toHaveLength(1);
    expect(due[0].paneId).toBe(DESIGN_STUDIO_SESSION_ID);
    expect(due[0].key).toBe("author:planner@1");
    expect(due[0].prompt).toContain("bsc ui list");           // reuse-first
    expect(due[0].prompt).toContain("bsc-deliver planner@1"); // closes the loop
  });

  it("routes a librarian commission to the algorithms studio pane", () => {
    const list = [c({ id: "x", target: "librarian", body: "graph-layout algo" })];
    const due = authorInjections(list, { librarian: 0 }, 9999, 3000, new Set());
    expect(due[0].paneId).toBe(ALGORITHMS_STUDIO_SESSION_ID);
    expect(due[0].prompt).toContain("bsc graph impl list");
  });

  it("never re-injects an already-injected commission, and skips delivered ones", () => {
    const list = [
      c({ id: "a", target: "designer" }),
      c({ id: "b", target: "designer", delivered: "k:c" }),
    ];
    const at = { designer: 0 };
    expect(authorInjections(list, at, 9999, 3000, new Set(["author:a"]))).toEqual([]); // guarded
    // 'b' is delivered → never an author task regardless of guard.
    expect(authorInjections([list[1]], at, 9999, 3000, new Set())).toEqual([]);
  });

  it("does not inject a target with no recorded activation time", () => {
    const list = [c({ id: "a", target: "designer" })];
    expect(authorInjections(list, {}, 9999, 3000, new Set())).toEqual([]);
  });
});

describe("studioNetworkDrive — deliver-back injections", () => {
  it("injects the artifact id back into the REQUESTER pane once, only when delivered", () => {
    const list = [
      c({ id: "a", from: "planner:p0", target: "designer", body: "a heatmap", delivered: "react-d3:heatmap" }),
      c({ id: "b", from: "planner:p0", target: "librarian" }),  // not delivered → nothing
    ];
    const due = deliverBackInjections(list, new Set());
    expect(due).toHaveLength(1);
    expect(due[0].paneId).toBe("planner:p0");                  // back to the requester, not the studio
    expect(due[0].key).toBe("deliver:a");
    expect(due[0].prompt).toContain("react-d3:heatmap");
    // Guarded once.
    expect(deliverBackInjections(list, new Set(["deliver:a"]))).toEqual([]);
  });
});

describe("studioNetworkDrive — prompt shape", () => {
  it("author prompt carries the ref when present", () => {
    const p = authorTaskPrompt(c({ id: "z", ref: { kind: "issue", number: 42 } }), "designer");
    expect(p).toContain("#42");
  });
  it("deliver-back names the target + the delivered id", () => {
    const p = deliverBackPrompt(c({ target: "librarian", body: "sort", delivered: "rust:quicksort" }));
    expect(p).toContain("librarian");
    expect(p).toContain("rust:quicksort");
  });
  it("STUDIO_PANE maps both targets to their session ids", () => {
    expect(STUDIO_PANE.designer).toBe(DESIGN_STUDIO_SESSION_ID);
    expect(STUDIO_PANE.librarian).toBe(ALGORITHMS_STUDIO_SESSION_ID);
  });
});
