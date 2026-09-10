// THE GLANCE STUDIO NODES ARE PINNED TO THE STORE THEIR TECHNOLOGIES COME FROM
// (`the-studio-session-set-is-derived-not-declared`).
//
// `PER_TECH_EXPANSION` in `team.ts` is the last place in this codebase where the studio technologies
// are written down rather than read. The session SET is derived — `studioSessionsFor` projects the
// compiled studio KINDS over an axis the app reads out of the algorithms graph and the kit collection,
// and the app refuses to start a studio the axis does not produce — but a Glance node is drawn from a
// team position, one level away from that, and threading the runtime axis to the two callers that
// build those graphs is a separate slice (`the-glance-studio-nodes-still-declare-their-technologies`).
//
// So until then the list is GATED rather than derived, and this is the gate. It reads the same
// `impl.tech` the librarian's axis is derived from, out of the committed record store, and fails when
// the drawn nodes and the store disagree in either direction:
//
//   * a node for a technology the graph does not hold — the `librarian-python` case. That node drew,
//     resolved to a pane, and opened a librarian session with nothing to curate. It was on the canvas
//     for as long as the declared roster existed, and no test could see it because nothing compared
//     the roster to the store.
//   * a technology the graph holds with no node — a language kit nobody can reach from the graph, and
//     the failure that the roster's own doc predicted ("a FOURTH tech appearing in the graph needs a
//     fourth entry here") without providing any way to notice it.
//
// The DESIGNER half is deliberately not derived here. Its axis is `kit.tech` off the component
// library's KIT collection, which lives in the user's store (`~/.base-studio-code/kits/`) and not in
// this repo, so a repo-only test cannot read it reproducibly — `mobile-studio-code` is a user kit. It
// is asserted for SHAPE instead, which still catches a malformed or empty entry.
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadStore, resolveStorePath } from "../../../../scripts/lib/recordStore.mjs";
import { readFileSync } from "node:fs";
import { PER_TECH_STUDIO_NODES } from "@/features/teams/lib/team";
import { studioAxis, studioSessionsFor } from "@/features/studio-sessions";

const REPO = resolve(__dirname, "../../../..");

/** Every technology the ALGORITHMS GRAPH holds — the librarian's axis, exactly as the app derives it
 *  (`bsc_graph::implementations()` → distinct `tech`).
 *
 *  Read from BOTH copies the build merges: the committed store (`graph/algorithms.json` plus
 *  `graph/records/<id>.json` per record) and the packaged seed. A technology present in either is a
 *  technology the running app's graph holds, and taking only one would let a real language kit look
 *  absent — which would fail this gate for a curator that genuinely exists. */
function librarianTechsInTheGraph(): string[] {
  const committed = loadStore(resolveStorePath(REPO)) as {
    implementations: { tech?: string }[];
  };
  const seed = JSON.parse(
    readFileSync(resolve(REPO, "src-tauri/data/knowledge/algorithms.json"), "utf8"),
  ) as { implementations: { tech?: string }[] };
  const techs = [...committed.implementations, ...seed.implementations]
    .map((i) => i.tech)
    .filter((t): t is string => !!t);
  return [...new Set(techs)].sort();
}

describe("the drawn studio nodes match the store their technologies come from", () => {
  it("reads a non-empty axis out of the store at all", () => {
    // Guard the guard. Every assertion below compares against this list, so a store path that stopped
    // resolving would make them all vacuous — an empty expectation matching an empty roster is the
    // failure mode a pinning test can least afford.
    const techs = librarianTechsInTheGraph();
    expect(techs.length, "no implementations found — the store path stopped resolving").toBeGreaterThan(1);
    expect(techs).toContain("rust");
    expect(techs).toContain("typescript");
  });

  it("draws one librarian node per technology the graph holds, and no others", () => {
    const want = librarianTechsInTheGraph().map((t) => `librarian-${t}`).sort();
    expect([...PER_TECH_STUDIO_NODES.librarian].sort()).toEqual(want);
  });

  it("has no librarian node for python, which has never had a record here", () => {
    // Stated as its own case because it is the finding, not an example of one: this exact node drew on
    // the canvas and opened a session for a technology with zero records.
    expect(librarianTechsInTheGraph()).not.toContain("python");
    expect(PER_TECH_STUDIO_NODES.librarian).not.toContain("librarian-python");
  });

  it("names a node the session projection actually produces, for every entry", () => {
    // The two rosters must not merely be the same length — a node whose id does not correspond to a
    // real session id draws and then opens nothing, which is the worst failure mode here because it
    // looks like it is working.
    const axis = studioAxis(
      PER_TECH_STUDIO_NODES.librarian.map((n) => n.replace(/^librarian-/, "")),
      PER_TECH_STUDIO_NODES.designer.map((n) => n.replace(/^designer-/, "")),
    );
    const panes = new Set(studioSessionsFor(axis).map((d) => d.paneId));
    for (const [role, nodes] of Object.entries(PER_TECH_STUDIO_NODES)) {
      for (const nodeId of nodes) {
        const tech = nodeId.slice(role.length + 1);
        expect(tech, `${nodeId} carries no technology`).not.toBe("");
        const prefix = role === "librarian" ? "algorithms-studio:librarian-" : "design-studio:designer-";
        expect(panes.has(`${prefix}${tech}`), `${nodeId} resolves to no session`).toBe(true);
      }
    }
  });
});
