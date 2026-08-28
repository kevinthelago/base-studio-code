// L0 is scoped to its network, and the architect OPENS rather than DRILLS.
//
// Asserted against the shipped records, because those are what mount — and because the two claims here
// were each false in a way no unit test noticed before: the graph drew every project on every tab, and
// the architect drilled into a team graph that ignored which architect had been clicked.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { architectNodeId } from "@/features/glance/lib/glanceGraph";
import { studioPaneIdForNode } from "@/features/glance/lib/studioProject";
import { decideExpand } from "@/features/glance/lib/expandNode";

const GLANCE: string = JSON.parse(
  readFileSync("src-tauri/data/components/app/features/glance/glancepage.json", "utf8"),
).srcText;
const IMPLS = JSON.parse(
  readFileSync("src-tauri/data/knowledge/algorithms.json", "utf8"),
).implementations as { id: string; code: string }[];
const STUDIO_PROJECT = IMPLS.find((i) => i.id === "studio-project.ts")!.code;

describe("a network architect node resolves to its own session", () => {
  it("maps `architect:network-<slug>` to the pane `network-<slug>:architect`", () => {
    // The id `bsc session stop` also names, and the one Rust derives the workspace directory from. If
    // this drifts, the session still launches and still runs — it is merely unreachable and unwatchable.
    expect(studioPaneIdForNode(architectNodeId("network-kitchen"))).toBe("network-kitchen:architect");
    expect(studioPaneIdForNode(architectNodeId("network-finance"))).toBe("network-finance:architect");
  });

  it("leaves a non-network architect node alone", () => {
    // A persona-shaped architect id is not a network and must not mint a pane that no store backs.
    expect(studioPaneIdForNode(architectNodeId("persona-architect"))).toBeNull();
  });
});

describe("L0 is scoped to the active network tab", () => {
  it("filters the project list by the tab's network", () => {
    expect(GLANCE).toMatch(/allProjects\.filter\(\(p\) => p\.network === networkTab\.id\)/);
  });

  it("keeps `All projects` unfiltered, and gives it no architect node", () => {
    // No single architect owns everything; inventing one there would draw an edge nobody could act on.
    expect(GLANCE).toMatch(/networkTab \? \[\{ id: networkTab\.id/);
    expect(GLANCE).toMatch(/: \[\]\),/);
  });

  it("edges the tab's projects to the NETWORK as their architect", () => {
    // `architect` on a ProjectLite means "which architect node this edges to" — an id that is now a
    // network id. The per-project persona column is the older answer and no longer what the graph draws.
    expect(GLANCE).toMatch(/architect: networkTab\.id/);
  });
});

describe("the architect opens its session instead of drilling", () => {
  it("clicks through to `expandNode`, not `setDrill`", () => {
    expect(GLANCE).toMatch(/else if \(isArchitectNodeId\(id\)\) expandNode\(id\)/);
  });

  it("can never be a drill target, however the value arrived", () => {
    // `glanceDrill` is restored by the app-wide nav history and reachable by `bsc navigate`, so a drill
    // recorded before this change would land on a branch that no longer exists. Guarding at the source
    // is what makes the removed branch genuinely dead rather than merely unlikely.
    expect(GLANCE).toMatch(/isArchitectNodeId\(rawDrill\) \? null : rawDrill/);
  });

  it("removed the drill branch rather than leaving it unreachable", () => {
    // The IMPORT is the signal, not the identifier: the two remaining mentions are comments recording
    // why the branch went, which is exactly the kind of prose that should survive a deletion. An
    // unused import would not compile, so its absence is what proves nothing calls it.
    expect(GLANCE).not.toMatch(/^import[^;]*buildArchitectFleetData/m);
    expect(GLANCE).not.toMatch(/return buildArchitectFleetData/);
  });
});

describe("the two competing stories about the architect are resolved", () => {
  it("no longer claims there is no architect persona to assign a project to", () => {
    // This sentence was live in `studioProject` at the same time as the persona-ownership machinery in
    // `glanceData` — two stories contradicting each other, both true once. The architect is per NETWORK.
    expect(STUDIO_PROJECT).not.toMatch(/There is no architect persona to assign a project to any/);
    expect(STUDIO_PROJECT).toMatch(/THE ARCHITECT IS PER NETWORK/);
  });
});

/** The body of `expandNode` as SHIPPED, from its arrow head to the matching two-space `};`. Sliced
 *  rather than regexed whole so the assertions below can talk about ORDER, which is what was wrong. */
function expandNodeBody(src: string): string {
  const start = src.indexOf("const expandNode = (id: string) => {");
  const end = src.indexOf("\n  };", start);
  return start < 0 || end < 0 ? "" : src.slice(start, end);
}

describe("expandNode admits a STUDIO node that has no drill — the L0 architect", () => {
  // THE BUG THIS PINS. `expandNode` opened with an unconditional `if (!drill) return;`, and
  // `onNodeClick` routes the architect into it from the `else` of `if (drill)` — i.e. only at L0,
  // where `drill` is null by definition. So the call bailed on its first line and the click did
  // nothing, on every network tab, while the session sat warm and reachable in its
  // `NetworkArchitectMount`.
  //
  // "clicks through to `expandNode`, not `setDrill`" above passed the whole time it was broken: it
  // proved the CALL SITE existed, never that the call did anything. Order is the property that was
  // wrong, so order is what these assert.
  const body = expandNodeBody(GLANCE);

  it("finds the function at all", () => {
    expect(body, "expandNode's body must be sliceable, or the rest of this block proves nothing")
      .not.toBe("");
  });

  it("does not bail before it knows whether the node is app-owned", () => {
    const decides = body.indexOf("const isStudio =");
    const guards = body.indexOf("if (!isStudio && !drill) return;");
    expect(decides).toBeGreaterThanOrEqual(0);
    expect(guards, "the drill guard must come AFTER isStudio is known").toBeGreaterThan(decides);
  });

  it("has no unconditional drill guard as its first statement", () => {
    expect(body).not.toMatch(/=> \{\s*\n\s*if \(!drill\) return;/);
  });

  it("still refuses a FLEET node with no drill — the guard narrowed, not removed", () => {
    // The fleet path's pane id is `fleetPaneId(drill, id)`, so without a drill there is nothing to
    // expand. Deleting the guard outright would trade a dead click for a bad pane id.
    expect(body).toMatch(/if \(!isStudio && !drill\) return;/);
  });
});

describe("a studio node's expansion never reads the drill", () => {
  it("resolves to a morph or a select — both return before the fleet path", () => {
    // This is WHY the narrowed guard is safe: an app-owned node's action is decided without a drill,
    // and both outcomes return from the switch before anything reads one.
    // The three fleet fields are required by the type and IGNORED when `isAppOwnedSession` is true —
    // set to the values that would send a FLEET node down the resume path, so the assertion is that
    // app-ownership wins over them rather than that they happened to be benign.
    const fleet = { paneIsLive: true, paneIsComplete: false, canResumeInPlace: true };
    expect(decideExpand({ isAppOwnedSession: true, studioMorphs: true, ...fleet }).kind)
      .toBe("studio-morph");
    expect(decideExpand({ isAppOwnedSession: true, studioMorphs: false, ...fleet }).kind)
      .toBe("select");
  });
});
