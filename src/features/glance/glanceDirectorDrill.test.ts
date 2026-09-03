// A fleet-less project draws the director IT ACTUALLY HAS — and nothing it does not.
//
// THREE answers have lived at this branch, and the first two were wrong in opposite directions:
//   v1  `buildFleetData` FABRICATED a reviewer, an auditor and 2-4 hash-counted workers.
//   v2  a substituted director-only plan ASSUMED every project has a director.
//   v3  drawing nothing HID a director that was demonstrably running (pain-point-finder, pid 3082124,
//       LIVE in `bsc fleet directors`, with `(no fleet)` in its plan store).
//
// THE RULE: draw a node when a SESSION EXISTS FOR IT. Never from an assumed plan, never from a
// generated topology. `livePaneIds` is the evidence — tab membership, which GlanceWorkspace documents
// as "a durable, symmetric this-agent-has-a-terminal signal for BOTH workers AND the DIRECTOR", added
// because the director is not a stream and idles between prompts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildRealFleetData } from "@/features/glance/lib/glanceFleet";

const GLANCE: string = JSON.parse(
  readFileSync("src-tauri/data/components/app/features/glance/glancepage.json", "utf8"),
).srcText;

describe("the fleet-less drill", () => {
  it("decides from an existing PANE, not from an assumed plan", () => {
    // The evidence, and it must be the drilled project's own director pane.
    expect(GLANCE).toMatch(/const hasDirectorPane = !!drill && livePaneIds\.has\(fleetPaneId\(drill, "director"\)\)/);
  });

  it("draws the director when its pane exists, and nothing when it does not", () => {
    expect(GLANCE).toMatch(/: hasDirectorPane\s*\n\s*\? buildRealFleetData\(DIRECTOR_ONLY_FLEET, personas, drillTeam\)\s*\n\s*: EMPTY_FLEET_DATA;/);
    expect(GLANCE).toMatch(/const EMPTY_FLEET_DATA = \{ rawNodes: \[\], rawEdges: \[\], sample: false \}/);
  });

  it("re-runs the graph when a director appears or goes, not on every liveness poll", () => {
    // A boolean in the deps, never the whole `livePaneIds` set: the set churns on every poll, and the
    // base graph is deliberately separate from the liveness overlay applied downstream.
    //
    // `surfaceRoster` joined the list and is allowed for the SAME reason, not as an exception: its
    // setter keeps the previous reference when the roster is unchanged, so it cannot churn either.
    // Anything appended here must clear that bar — a value that gets a new reference per poll would
    // rebuild the whole drill graph on a timer.
    // `planFeatures` / `planStreams` joined for the SAME reason `surfaceRoster` did, and had to clear
    // the same bar: both setters keep the PREVIOUS reference when the plan is unchanged (comparing
    // slugs, and stream id + feature), so neither can hand the memo a new array on a timer. A feature
    // roster changes when someone edits the plan, so "no change" is the common case and costs nothing.
    expect(GLANCE).toMatch(/activeDebugRequests, drill, hasDirectorPane, surfaceRoster, planFeatures, planStreams\]\);/);
    // The bar itself, asserted rather than described: each new value's setter must return `prev` on a
    // no-op. A setter that always built a fresh array would satisfy the deps line above and still
    // rebuild the drill every poll — which is the failure this test exists to prevent, not the spelling.
    for (const setter of ["setPlanFeatures", "setPlanStreams"]) {
      const body = GLANCE.slice(GLANCE.indexOf(`${setter}((prev)`));
      expect(body.slice(0, 400), `${setter} must keep the old reference when nothing changed`).toMatch(/\? prev\b/);
    }
    expect(GLANCE).not.toMatch(/activeDebugRequests, drill, livePaneIds\]/);
  });

  it("yields exactly one node — the director — on the real builder", () => {
    // Not a hand-rolled node: `fleetToOrg` already emits precisely this for `director.enabled` with no
    // streams, on the id `fleetPaneId` resolves to `<project>:director`, so it morphs like any other.
    const data = buildRealFleetData(
      { recommended: 0, reasoning: "", streams: [], director: { enabled: true } },
      [],
    );
    expect(data.rawNodes.map((n) => n.id)).toEqual(["director"]);
    expect(data.rawEdges).toEqual([]);
  });

  it("still invents nothing — no sample generator survives", () => {
    expect(GLANCE).not.toMatch(/buildFleetData\(/);
  });
});
