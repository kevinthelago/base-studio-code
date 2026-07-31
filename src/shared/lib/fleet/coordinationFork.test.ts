// Fork visibility (#4106). A director spawned a general-purpose subagent titled "Wake
// mobile-crash-reporting worker" to do a worker's job, and nothing in the system could see it: a fork
// has no pane, no roster row, no worktree and no branch. These cover the event that fixes that.
import { describe, it, expect } from "vitest";
import { parseCoordLine, applyCoordEvent } from "./coordinationLog";
import { emptyCoordState } from "./coordinationState";
import type { CoordState } from "./coordination.types";

const line = (session: string, desc: string, type = "general-purpose") =>
  `2026-07-31T20:15:55Z\t${session}\tfork\t${desc}\t${type}`;

describe("parseCoordLine — fork", () => {
  it("parses the real event that prompted this", () => {
    const e = parseCoordLine(line("studio-code:director", "Wake mobile-crash-reporting worker"));
    expect(e).toEqual({
      type: "fork",
      session: "studio-code:director",
      description: "Wake mobile-crash-reporting worker",
      subagentType: "general-purpose",
      at: Date.parse("2026-07-31T20:15:55Z"),
    });
  });

  it("keeps the event when no subagent type was named", () => {
    // The hook emits an empty column rather than omitting it; an unnamed type must not drop the fork.
    const e = parseCoordLine("2026-07-31T20:15:55Z\tp:director\tfork\tReview six PRs\t");
    expect(e).toMatchObject({ type: "fork", description: "Review six PRs", subagentType: undefined });
  });

  it("rejects a fork with no description rather than recording a blank one", () => {
    expect(parseCoordLine("2026-07-31T20:15:55Z\tp:director\tfork\t\t")).toBeNull();
  });
});

describe("applyCoordEvent — fork", () => {
  const fork = (session: string, description: string, at: number) =>
    ({ type: "fork", session, description, at }) as const;

  it("records the fork so it is no longer an invisible actor", () => {
    const { state } = applyCoordEvent(emptyCoordState(), fork("p:director", "Wake worker", 1));
    expect(state.forks).toEqual([
      { id: "p:director@1", session: "p:director", description: "Wake worker", subagentType: undefined, at: 1 },
    ]);
  });

  it("does not multiply a fork when the log is replayed", () => {
    // ingestCoordLog replays the whole file; a re-read must not turn one fork into many.
    let s: CoordState = emptyCoordState();
    s = applyCoordEvent(s, fork("p:director", "Wake worker", 1)).state;
    s = applyCoordEvent(s, fork("p:director", "Wake worker", 1)).state;
    expect(s.forks.length).toBe(1);
  });

  it("keeps every distinct fork — the designer's harvest fan-out is 13 of them", () => {
    let s: CoordState = emptyCoordState();
    for (let i = 0; i < 13; i++) s = applyCoordEvent(s, fork("design-studio:designer", `Harvest chunk ${i}`, i)).state;
    expect(s.forks.length).toBe(13);
  });

  it("never wakes, readies or stalls anything — it is OBSERVATION, not coordination", () => {
    // A fork must not perturb the latch machinery: recording one is not a fleet transition.
    const out = applyCoordEvent(emptyCoordState(), fork("p:director", "Review PRs", 1));
    expect(out.woken).toEqual([]);
    expect(out.ready).toBe(false);
    expect(out.stalled).toEqual([]);
    expect(out.answered).toEqual([]);
    expect(out.assigned).toEqual([]);
  });
});
