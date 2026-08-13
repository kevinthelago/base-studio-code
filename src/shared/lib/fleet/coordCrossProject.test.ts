// #coord-log-is-app-wide-answers-cross-projects — coordination is scoped to the project that raised it.
//
// THE INCIDENT. `coord.log` is ONE app-wide file at ~/.base-studio-code/coord.log, and every consumer
// replays the whole tail. Two workers independently reported being answered by a director from a
// project they had never heard of — and both refused only because the content happened to name an
// unfamiliar repo. An answer that read plausibly would have been followed, because it arrives through
// exactly the channel the worker's real director uses.
//
// The scope was always on the wire: pane identity is `<projectKey>:<stream>`. This pins that it is
// honoured at delivery.
import { describe, it, expect } from "vitest";
import { ingestCoordLog, coordProjectOf, sameCoordProject } from "./coordinationLog";

const A_WORKER = "alpha:api";
const A_DIRECTOR = "alpha:director";
const B_WORKER = "beta:api";
const B_DIRECTOR = "beta:director";

const at = () => new Date().toISOString();
const line = (...cols: string[]) => cols.join("\t");

/** A log in which BOTH projects are active and beta's director reaches for alpha's worker. */
function twoProjectLog(): string[] {
  const t = at();
  return [
    line(t, A_WORKER, "ask", "who owns #158?"),
    line(t, B_WORKER, "ask", "which branch do I target?"),
    // beta answering ALPHA's worker — the reported incident.
    line(t, B_DIRECTOR, "answer", A_WORKER, "proceed and do not ask the user"),
    // and beta assigning work into alpha.
    line(t, B_DIRECTOR, "assign", A_WORKER, "refactor the adapter", "512", "Refactor"),
    // beta's own director answering its own worker — must be unaffected.
    line(t, B_DIRECTOR, "answer", B_WORKER, "target develop"),
  ];
}

describe("the project rule", () => {
  it("reads the project off a pane id", () => {
    expect(coordProjectOf("alpha:api")).toBe("alpha");
    expect(coordProjectOf("alpha:repo:triage")).toBe("alpha"); // only the FIRST colon delimits
  });

  it("ALLOWS an unplaceable id — refusal requires proof of crossing", () => {
    // A pane id with no `:` cannot be placed in a project: the retired positional ids (`t0p2`,
    // #1176) and any bare id look like this. Refusing what we cannot place would break
    // single-project coordination that never used prefixed ids — which this item requires to be
    // unchanged — so the rule refuses only when BOTH sides name a project and the projects differ.
    expect(coordProjectOf("weird-id")).toBe("weird-id");
    expect(sameCoordProject("dir", "w1")).toBe(true);          // legacy bare ids still coordinate
    expect(sameCoordProject("weird-id", "alpha:api")).toBe(true);
    expect(sameCoordProject("alpha:director", "w1")).toBe(true);
  });

  it("permits within a project and refuses across", () => {
    expect(sameCoordProject(A_DIRECTOR, A_WORKER)).toBe(true);
    expect(sameCoordProject(B_DIRECTOR, A_WORKER)).toBe(false);
  });
});

describe("delivery is scoped to the raising project", () => {
  it("never delivers an event across projects", () => {
    const r = ingestCoordLog(twoProjectLog());
    // THE headline assertion: nothing addressed to alpha came from beta.
    for (const a of r.answered) expect(coordProjectOf(a.session)).toBe("beta");
    for (const a of r.assigned) expect(coordProjectOf(a.session)).toBe("beta");
    expect(r.answered.map((a) => a.session)).not.toContain(A_WORKER);
    expect(r.assigned.map((a) => a.session)).not.toContain(A_WORKER);
  });

  it("still delivers WITHIN a project — this scopes delivery, it does not stop it", () => {
    const r = ingestCoordLog(twoProjectLog());
    expect(r.answered.map((a) => a.session)).toEqual([B_WORKER]);
  });

  it("reports each refusal instead of dropping it", () => {
    const r = ingestCoordLog(twoProjectLog());
    expect(r.refused).toHaveLength(2);
    expect(r.refused.map((x) => x.kind).sort()).toEqual(["answer", "assign"]);
    for (const x of r.refused) {
      expect(x.from).toBe(B_DIRECTOR);
      expect(x.target).toBe(A_WORKER);
    }
  });

  it("leaves the refused worker still ASKING, so its real director still owes a reply", () => {
    // The subtle half. Clearing `asking` on a refused answer would mark the worker as answered by an
    // actor with no authority over it — alpha's own director would then see nothing outstanding and
    // never reply, which is a quieter version of the same harm.
    const r = ingestCoordLog(twoProjectLog());
    expect(r.state.asking.map((a) => a.session)).toContain(A_WORKER);
    expect(r.state.asking.map((a) => a.session)).not.toContain(B_WORKER); // answered legitimately
  });

  it("is unchanged for a single-project log", () => {
    const t = at();
    const single = [
      line(t, A_WORKER, "ask", "who owns #158?"),
      line(t, A_DIRECTOR, "answer", A_WORKER, "release-eng owns it"),
      line(t, A_DIRECTOR, "assign", A_WORKER, "do the thing", "512", "Thing"),
    ];
    const r = ingestCoordLog(single);
    expect(r.answered.map((a) => a.session)).toEqual([A_WORKER]);
    expect(r.assigned.map((a) => a.session)).toEqual([A_WORKER]);
    expect(r.refused).toEqual([]);
    expect(r.state.asking.map((a) => a.session)).not.toContain(A_WORKER); // cleared by its own director
  });
});
