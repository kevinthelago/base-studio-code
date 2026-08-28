// L0 is scoped to its network, and the architect OPENS rather than DRILLS.
//
// Asserted against the shipped records, because those are what mount — and because the two claims here
// were each false in a way no unit test noticed before: the graph drew every project on every tab, and
// the architect drilled into a team graph that ignored which architect had been clicked.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { architectNodeId } from "@/features/glance/lib/glanceGraph";
import { studioPaneIdForNode } from "@/features/glance/lib/studioProject";

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
