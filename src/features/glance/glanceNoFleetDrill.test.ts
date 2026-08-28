// A project with NO planned fleet drills into an EMPTY graph — never an invented team.
//
// THE BUG: the no-fleet branch fell back to `buildFleetData`, a SAMPLE generator that emitted a
// director, a reviewer, an auditor and 2-4 `worker-N` nodes whose count was a hash of the project id.
// It carried `sample: true`, which earned only a small "sample topology · preview" chip — nowhere near
// enough to stop invented agents reading as this project's real team. The maintainer met it as "team
// nodes that don't or shouldn't exist. it's the director that should choose their team."
//
// The architect's fresh project was guaranteed to land there: `bsc fleet director new` builds its
// FleetPlan as a LAUNCH INPUT and deliberately does not write plan.db, so a just-handed-off project
// has a running director and no stored fleet at all.
//
// THERE IS NO FALLBACK NOW, and the generator is deleted rather than left unreachable. The graph shows
// what exists; until the director designs a team there is nothing to show.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as glanceFleet from "@/features/glance/lib/glanceFleet";

const GLANCE: string = JSON.parse(
  readFileSync("src-tauri/data/components/app/features/glance/glancepage.json", "utf8"),
).srcText;

describe("the no-fleet drill invents nothing", () => {
  it("has no sample-fleet generator left to call", () => {
    // Deleted, not merely unreferenced: an unreachable generator is one import away from returning.
    expect("buildFleetData" in glanceFleet).toBe(false);
  });

  it("draws an EMPTY graph rather than substituting a topology", () => {
    // Not even a synthesized director: a node no plan asserts is still a node the user did not put
    // there. `composed` present ⇒ the real builder; absent ⇒ nothing.
    expect(GLANCE).toMatch(/const EMPTY_FLEET_DATA = \{ rawNodes: \[\], rawEdges: \[\], sample: false \}/);
    expect(GLANCE).toMatch(/: EMPTY_FLEET_DATA;/);
  });

  it("keeps the real builder for a project that HAS a fleet", () => {
    // The fix must not cost a planned fleet its graph — that path is untouched.
    expect(GLANCE).toMatch(/buildRealFleetData\(composed, personas, drillTeam\)/);
    expect(typeof glanceFleet.buildRealFleetData).toBe("function");
  });
});
