// #4062 — the L0 project node's LIFECYCLE chip, and the drift guard over the three places the
// vocabulary is written down.
//
// The chip is a second attempt: #4052 deleted the first one because it ALWAYS produced a value
// (`resolveProjectCategory` ended in `isDraft ? greenfield : maintain`), so every unclassified project
// wore a confident label. The no-default rule is therefore the load-bearing assertion here, not a
// nicety — if it regresses, the axis is dead again in exactly the same way.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlanceCanvas } from "./GlanceCanvas";
import { buildGraph, LIFECYCLE_META } from "./lib/glanceGraph";
import { LIFECYCLES } from "@/features/planner/lib/classifyConfig";

/** Mount the canvas over one project node. `fleet` switches to the L1 (drill) shape. */
function renderGraph(node: Parameters<typeof buildGraph>[0][number], fleet = false) {
  const model = buildGraph([node], []);
  return render(
    <GlanceCanvas
      model={model}
      dragMoved={{ current: false }}
      focus={null}
      selNodeId={null}
      selEdgeId={null}
      onHoverNode={() => {}}
      onHoverEdge={() => {}}
      onSelectNode={() => {}}
      onSelectEdge={() => {}}
      fleet={fleet}
    />,
  );
}

const project = { id: "p", slug: "Payments", role: "service" as const, health: "healthy" as const, activity: "idle" as const };

describe("the L0 lifecycle chip (#4062)", () => {
  it("renders the discovered lifecycle on a classified project", () => {
    const { container } = renderGraph({ ...project, lifecycle: "harvest" });
    expect(container.textContent).toContain("harvest");
  });

  it("renders NOTHING for an UNCLASSIFIED project — no default, no `role` fallback", () => {
    // The whole reason #4052 deleted the previous chip. A defaulted label is a lie that looks like
    // data, and `role` would resurrect the hash-per-id microservices tier the chip replaced.
    const { container } = renderGraph(project);
    for (const key of Object.keys(LIFECYCLE_META)) {
      expect(container.textContent, `unclassified node must not read "${key}"`).not.toContain(key);
    }
    expect(container.textContent).not.toContain("SERVICE");
  });

  it("ignores an UNKNOWN lifecycle token rather than rendering it raw", () => {
    // A planner writing a value this build does not know about must degrade to no chip, not paint a
    // colourless label with an undefined accent.
    const { container } = renderGraph({ ...project, lifecycle: "sideways" });
    expect(container.textContent).not.toContain("sideways");
  });

  it("gives every lifecycle its OWN accent, distinct from the health palette", () => {
    const colors = Object.values(LIFECYCLE_META).map((m) => m.color);
    expect(new Set(colors).size).toBe(colors.length);          // no two lifecycles share a hue
    for (const c of colors) expect(c).toContain("--graph-lifecycle-");  // never a health token
  });
});

describe("the lifecycle vocabulary is written down three times — keep them in lockstep", () => {
  const rust = readFileSync(join(process.cwd(), "crates/plandb/src/validate.rs"), "utf8");
  const directive = readFileSync(join(process.cwd(), "src-tauri/data/stages/discovery.json"), "utf8");

  it("the Rust validator accepts exactly the TS `LIFECYCLES`", () => {
    // `bsc plan classify set` rejects an unknown token, so a value the app can render but the CLI
    // refuses (or the reverse) is a silently broken write path.
    const declared = rust.match(/pub const LIFECYCLES: \[&str; (\d+)\] = \[([^\]]+)\]/);
    expect(declared, "LIFECYCLES not found in validate.rs").toBeTruthy();
    const tokens = [...declared![2].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(tokens.sort()).toEqual([...LIFECYCLES].sort());
    expect(Number(declared![1]), "the array length must match its contents").toBe(tokens.length);
  });

  it("every lifecycle has a chip entry — a value with no meta renders blank", () => {
    expect(Object.keys(LIFECYCLE_META).sort()).toEqual([...LIFECYCLES].sort());
  });

  it("the discovery directive names every lifecycle, or the planner never writes it", () => {
    // The directive is the ONLY thing that tells the planner these values exist. A token missing here
    // is a token no project will ever carry — which is how the first lifecycle axis starved.
    for (const l of LIFECYCLES) {
      expect(directive, `discovery.json must offer \`${l}\``).toContain(`\`${l}\``);
    }
  });
});
