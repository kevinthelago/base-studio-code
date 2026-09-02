// The COMMAND-SURFACE band vocabulary (`epic-command-surfaces-are-nodes`, slice 1).
//
// One node per CRATE — the 2026-09-01 decision. The node's job is MAINTENANCE, so every workspace
// member gets one and not only the 37 that expose verbs: `bsc-util` exposes none and is the crate
// whose change reaches most of the workspace, which makes it exactly the one that needs an owner.
// "Has verbs" is a facet, not the criterion for existing.
//
// These assertions are about the VOCABULARY, which is what the node builder will be written against.
// Two of them exist because the alternatives were live possibilities and each would have been wrong
// in a way nothing else would catch: reusing the `library` kind (already taken by cross-graph
// algorithm/sound nodes), and keying on a bare crate name (indistinguishable from a project key).
import { describe, it, expect } from "vitest";
import {
  SURFACE_META,
  SURFACE_NODE_PREFIX,
  surfaceNodeId,
  surfaceCrateOfNode,
  bandNodeMeta,
  isBandNode,
  LIBRARY_META,
  MCP_META,
  SERVICE_META,
  type GNodeKind,
} from "@/features/glance/lib/glanceGraph";

describe("the command-surface band", () => {
  it("is its own kind, not a reuse of `library`", () => {
    // `library` already means a cross-graph algorithm or sound node. Reusing it would put crates in
    // the same band as `@bsc/algorithms/fibonacci`, which is a different dimension entirely.
    const kind: GNodeKind = "surface";
    expect(bandNodeMeta({ kind })).toBe(SURFACE_META);
    expect(bandNodeMeta({ kind })).not.toBe(LIBRARY_META.algo);
    expect(bandNodeMeta({ kind })).not.toBe(MCP_META);
    expect(bandNodeMeta({ kind })).not.toBe(SERVICE_META);
  });

  // REVERSED 2026-09-02 by the maintainer: "lets treat these like normal nodes, instead of placing
  // them in a box. they should flow within the graph." Kept as an assertion rather than deleted, so
  // the decision is visible where the old one was — this is the second time this graph has fenced
  // something that belonged with the work (`architect-sits-with-the-projects` was the first).
  //
  // The band is for a shared DEPENDENCY the projects CONSUME. A crate is not consumed by the project;
  // it IS the project, decomposed.
  it("does NOT render in the fenced band — a crate flows with the graph", () => {
    expect(isBandNode({ kind: "surface" })).toBe(false);
  });

  it("carries a full presentation row, so the inspector has nothing to invent", () => {
    for (const [field, value] of Object.entries(SURFACE_META)) {
      expect(typeof value, `${field} must be a string`).toBe("string");
      expect(value.length, `${field} must not be blank`).toBeGreaterThan(0);
    }
    // Its accent must not collide with a neighbouring dimension, or two bands read as one.
    const others = [MCP_META.color, SERVICE_META.color, ...Object.values(LIBRARY_META).map((m) => m.color)];
    expect(others).not.toContain(SURFACE_META.color);
  });

  /** A bare crate name is a valid project key (`[a-z0-9-]`, no colon), so the namespace is load-bearing. */
  it("namespaces its id so a crate can never collide with a project key", () => {
    expect(surfaceNodeId("bsc-util")).toBe("surface:bsc-util");
    expect(surfaceNodeId("bsc-util")).not.toBe("bsc-util");
    expect(surfaceNodeId("studio-code")).toContain(":");
  });

  it("round-trips the crate out of a node id", () => {
    for (const crate of ["bsc-util", "plandb", "base-studio-code", "bsc-data", "bsc-llm"]) {
      expect(surfaceCrateOfNode(surfaceNodeId(crate))).toBe(crate);
    }
    // An id that carries no prefix comes back unchanged rather than being silently truncated.
    expect(surfaceCrateOfNode("bsc-util")).toBe("bsc-util");
    expect(SURFACE_NODE_PREFIX.endsWith(":")).toBe(true);
  });

  /**
   * The key is the cargo PACKAGE name. Three names are in play and only this one is right: the
   * DIRECTORY differs for `crates/data` (bsc-data) and `crates/llm` (bsc-llm), and the LIB TARGET
   * differs again for llm, whose dispatch arm is `llm::cli::run`. Keying on either of the others
   * gets llm wrong and looks right everywhere else.
   */
  it("keys on the package name, which is not always the directory", () => {
    expect(surfaceNodeId("bsc-data")).toBe("surface:bsc-data");
    expect(surfaceNodeId("bsc-llm")).toBe("surface:bsc-llm");
    // The app crate's package is `base-studio-code`, not `src-tauri`.
    expect(surfaceCrateOfNode(surfaceNodeId("base-studio-code"))).toBe("base-studio-code");
  });
});
