// #expanding-a-node-resumes-its-session — what an expand click means, per node state.
import { describe, it, expect } from "vitest";
import { decideExpand, COMPLETE_REASON, type ExpandInput } from "@/features/glance/lib/expandNode";

const fleet = (over: Partial<ExpandInput> = {}): ExpandInput => ({
  isStudioProject: false,
  paneIsLive: false,
  paneIsComplete: false,
  canResumeInPlace: true,
  ...over,
});

describe("decideExpand", () => {
  it("a node with NO pane resumes it — the click is the resume", () => {
    // The behaviour this item exists for. Before it, clicking a non-live node selected it, and after
    // the right pane was retired selection shows nothing at all — a dead click.
    expect(decideExpand(fleet()).kind).toBe("expand-and-resume-pane");
  });

  it("a node whose build tab is gone brings the fleet back", () => {
    expect(decideExpand(fleet({ canResumeInPlace: false })).kind).toBe("expand-and-resume-fleet");
  });

  it("a LIVE node still restarts its agent — 'live' is tab membership, not a running agent", () => {
    // The trap. `livePaneIds` means a session CELL exists (glanceFleet.ts); #3998 measured 77 of 78
    // fleet panes reading as live while sitting at a bare `$` prompt. Expanding one has to revive it,
    // because nothing remounts such a pane — the shell is all there is to type into.
    expect(decideExpand(fleet({ paneIsLive: true })).kind).toBe("expand-and-restart-agent");
  });

  it("a COMPLETE worker is refused, and does NOT expand (#4029)", () => {
    const a = decideExpand(fleet({ paneIsComplete: true }));
    expect(a.kind).toBe("refuse-complete");
    expect(a.kind === "refuse-complete" && a.reason).toBe(COMPLETE_REASON);
  });

  it("COMPLETE beats LIVE — a finished worker is not restarted by a stray click", () => {
    // Order matters: a completed worker can still be a live cell, and the refusal has to win or the
    // guard is decorative.
    expect(decideExpand(fleet({ paneIsComplete: true, paneIsLive: true })).kind).toBe("refuse-complete");
  });

  it("a studio node with a morph opens it — its own lazy start does the rest", () => {
    expect(decideExpand({ ...fleet(), isStudioProject: true, studioMorphs: true }).kind).toBe("studio-morph");
  });

  it("a studio node with NO morph (a library/resource node) just selects — there is no session", () => {
    expect(decideExpand({ ...fleet(), isStudioProject: true, studioMorphs: false }).kind).toBe("select");
  });

  it("the studio branch ignores fleet state entirely — a studio has no fleet pane to be complete", () => {
    const a = decideExpand({ ...fleet({ paneIsComplete: true, paneIsLive: true }), isStudioProject: true, studioMorphs: true });
    expect(a.kind).toBe("studio-morph");
  });
});
