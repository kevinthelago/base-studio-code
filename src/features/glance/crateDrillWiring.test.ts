// THE CRATE DRILL'S CLICK HAS TO BE ROUTED (`a-crate-node-drills-into-its-verbs`).
//
// Inside a drill every node was sent to `expandNode`, which is right for a session and DEAD for a
// crate: it computed `fleetPaneId(drill, "surface:<crate>")`, a pane that cannot exist, so the click
// did nothing at all. A dead click reads as a broken app rather than an unimplemented feature — and no
// unit test of the graph builder can see it, because the builder is fine and simply never runs.
//
// A WIRING guard, like `glanceFoldsAreCalled`: it proves the route exists and where, not that the
// picture is right. `crateDrillGraph`'s own behaviour is pinned in `glanceSurfaceNodes.test.ts`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src: string = JSON.parse(
  readFileSync("src-tauri/data/components/app/features/glance/glancepage.json", "utf8"),
).srcText;

describe("a crate node's click drills instead of trying to expand a session", () => {
  it("reads the workspace at all — an empty scan would pass every assertion below", () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("const onNodeClick");
  });

  it("routes a crate to the second layer, BEFORE the expandNode fallback", () => {
    const drillAt = src.indexOf("else if (isSurfaceNodeId(id)) {");
    const expandAt = src.indexOf("else expandNode(id);");
    expect(drillAt).toBeGreaterThan(-1);
    expect(expandAt).toBeGreaterThan(-1);
    // Order is the whole fix: `expandNode` is the catch-all, so a crate branch after it never runs.
    expect(drillAt).toBeLessThan(expandAt);
  });

  it("the second layer wins over the fleet graph when it is open", () => {
    // The FEATURE layer joined this chain (`clicking-a-feature-node-is-a-dead-click`). Both inner
    // layers sit inside a project drill and are mutually exclusive in practice — a feature node and a
    // crate node cannot both be open — but the order is still written down rather than left to luck.
    expect(src).toContain("const model = crateModel ?? featureModel ?? fleetModel ?? projectModel;");
    // …and everything downstream reads the same graph, or the sidebar and the canvas disagree.
    expect(src).toContain("const data = crateData ?? featureData ?? liveFleetData ?? projectData;");
  });

  // THE FEATURE LAYER — the same wiring, one band over, and it shipped broken for the same reason the
  // crate layer did: a feature owns no pane, so `expandNode` computed `fleetPaneId(drill,
  // "feature:<slug>")` and the click did nothing at all.
  describe("a feature node's click drills into its streams", () => {
    it("routes BEFORE the expandNode catch-all", () => {
      const drillAt = src.indexOf("else if (isFeatureNodeId(id)) {");
      const expandAt = src.indexOf("else expandNode(id);");
      expect(drillAt, "the feature branch is missing — the click is dead again").toBeGreaterThan(-1);
      expect(drillAt).toBeLessThan(expandAt);
    });

    it("builds the drill from the SAME rosters the band counted", () => {
      // A drill fed from a second read could disagree with the card that was clicked.
      expect(src).toContain("featureDrill(row, planStreams, storeOfRecord)");
      expect(src).toContain("planFeatures.find((f) => f.slug === slug)");
    });

    it("steps out one layer at a time, and cannot strand", () => {
      expect(src).toContain("if (featureNode) {");
      expect(src).toContain("setFeatureNode(null);");
      expect(src).toContain("if (!drill && featureNode) setFeatureNode(null);");
    });

    it("a stream opens its SESSION; a required record selects", () => {
      // A stream carries the fleet's own node id, so `expandNode` resolves the same pane whichever
      // graph the user came through. A required record is shared library code with nothing to run.
      expect(src).toContain('else if (featureNode && id.startsWith("freq:")) pickNode(id);');
      expect(src).toContain("else if (featureNode) expandNode(id);");
      const selectAt = src.indexOf('else if (featureNode && id.startsWith("freq:"))');
      const expandAt = src.indexOf("else if (featureNode) expandNode(id);");
      // Order matters exactly as it does for the crate branch: the catch-all must come last, or a
      // required record would try to open a pane that cannot exist.
      expect(selectAt).toBeLessThan(expandAt);
    });

    it("names the layer you are in on the way back", () => {
      expect(src).toContain('featureNode ? "← features"');
    });

    it("keys the fit on the feature graph being DISPLAYED, not on the intent", () => {
      // Same trap the crate layer hit: keying on the click lands a render before the graph swaps, so
      // the viewport frames the graph that is about to be replaced.
      expect(src).toContain("featureData ? `feature:${featureNode}`");
    });
  });

  it("steps out one layer at a time", () => {
    // Collapsing both levels into one hop throws away the layer just navigated into.
    expect(src).toContain("if (crateNode) {");
    expect(src).toContain("setCrateNode(null);");
  });

  it("clears the crate layer when the project drill goes, so it cannot strand", () => {
    expect(src).toContain("if (!drill && crateNode) setCrateNode(null);");
  });

  it("only real crate KINDS reach the legend — a verb's caption is its noun", () => {
    // At L2 the verb nodes are also `kind: "surface"` but captioned with their NOUN. Feeding those to
    // the crate-kind colour table yields `undefined`, i.e. a legend row with no colour.
    expect(src).toContain("k in CRATE_KIND_ROLE");
  });

  // THE TWO BUGS THAT MADE THE LAYER INVISIBLE, both shipped green.
  it("guards the click with a PREDICATE, never with the id converter", () => {
    // `surfaceCrateOfNode` returns the id UNCHANGED when there is no prefix, so it is truthy for every
    // node ever passed to it. As a click guard it routed every node — sessions included — into the
    // crate layer and killed session expansion outright. A converter is not a test.
    expect(src).not.toContain("else if (surfaceCrateOfNode(id))");
    expect(src).toContain("else if (isSurfaceNodeId(id)) {");
  });

  // THE DEPTH IS THE MODE'S (`nodes-are-features-and-surfaces`). Both sub-layers are gated on the
  // same pure rule, and the branch still has to SELECT when it does not drill — a mode that simply
  // dropped the click would reintroduce the dead click this whole file exists for, one condition
  // deeper and harder to see.
  it("gates BOTH sub-layers on the mode, and still selects when it does not drill", () => {
    for (const layer of ["crate", "feature"]) {
      expect(src, `${layer} is not gated on the mode`).toContain(`opensSubLayer(sessionMode, "${layer}")`);
    }
    const crateAt = src.indexOf('opensSubLayer(sessionMode, "crate")');
    const elseAt = src.indexOf("else pickNode(id);", crateAt);
    expect(elseAt, "a claude-mode crate click must SELECT, not vanish").toBeGreaterThan(crateAt);
    // The mode comes from the chain `bsc session mode` writes — never a second setting.
    expect(src).toContain('["session", "mode", "--project", drill, "--json"]');
  });

  it("counts the sessions on THIS LAYER, not the whole project", () => {
    // The "End N sessions" button named the drilled PROJECT's panes at every depth, so the crate layer
    // — whose nodes own no pane at all — still offered to end fourteen sessions that were nowhere on
    // screen. A control that acts on things the user cannot see is worse than a missing one, and this
    // one KILLS.
    expect(src).toContain("if (!crateNode) return inProject;");
    expect(src).toContain("return inProject.filter((pane) => onScreen.has(pane));");
    // resolved per node the same way `isLiveAgent` does, so toolbar and graph cannot disagree
    expect(src).toContain("studioPaneId(n.id) ?? fleetPaneId(drill, n.id)");
  });

  it("a noun or verb click OPENS its persona session", () => {
    // This is what a dead click became. The node resolves to an app-owned pane, so `expandNode` takes
    // the studio-morph path and the terminal opens in the graph.
    expect(src).toContain("else if (crateNode && surfacePaneIdForNode(id)) void openSurfaceSession(id);");
  });

  it("reads the CHARTER from the persona store, never inlining it", () => {
    // One copy of what an operator or a maintainer is. Editing the persona changes every session
    // started afterwards; a second description here would drift from it.
    expect(src).toContain('["persona", "get", personaId]');
    // The DRILL DOC rides along too (`a-session-is-taught-its-surface`): the charter lists the noun's
    // verbs as literal command lines rather than sending the session to discover them, and `crateDoc`
    // is the copy already in hand at launch.
    expect(src).toContain("surfaceCharter(assignment, persona.startPrompt as string, crateDoc)");
  });

  it("refuses to launch with no charter rather than starting an unbriefed agent", () => {
    // An agent with no brief gets the whole repository and no instruction, which is worse than not
    // starting it — and the personas are seeded, so an absence is a real fault worth surfacing.
    expect(src).toContain("if (!persona?.startPrompt)");
    expect(src).toContain("bsc persona reseed");
  });

  it("puts the persona's model and provider in the store BEFORE the slot mounts", () => {
    // Both are read AT LAUNCH, so setting them after the pane exists is too late — and the failure is
    // silent: Claude Code drops an unknown `--model` rather than refusing it, so the session simply
    // runs the wrong harness with no error anywhere.
    expect(src).toContain("setPaneModel(paneId, persona.model);");
    expect(src).toContain("const provider = providerForModel(persona.model);");
    const set = src.indexOf("setPaneModel(paneId, persona.model);");
    const register = src.indexOf("setSurfacePanes((prev) =>");
    expect(set).toBeLessThan(register);
  });

  it("uses the SHARED provider rule, not a second copy", () => {
    // `streamPaneWiring` decides the same thing for fleet panes. Two copies of "is this a tier" is
    // exactly how the persona level and the stream level drifted in the first place.
    expect(src).toContain('from "@/app/console/lib/models"');
  });

  it("registers the pane BEFORE opening the morph", () => {
    // `TerminalSlot` owns the pane; the morph re-parents that same terminal rather than spawning a
    // second. Opening first would ask for a pane that does not exist yet.
    const register = src.indexOf("setSurfacePanes((prev) =>");
    const open = src.indexOf("expandNode(nodeId);");
    expect(register).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(register);
  });


  // THE FIT MUST KEY ON THE GRAPH SHOWN, NOT ON THE INTENT TO CHANGE IT.
  //
  // Keying on `drill` alone never re-fitted the crate layer at all. Keying on `drill, crateNode` fitted
  // one render EARLY: the crate document arrives async, so entering framed the fleet world and leaving
  // framed the crate world — each time framing the graph about to be replaced, which is an empty canvas
  // you have to drag out of. `useGraphViewport`'s own world-change re-fit cannot rescue it, because
  // dragging sets `userMoved`, which is precisely what disables that re-fit.
  it("keys the fit on which graph is displayed", () => {
    expect(src).toContain("}, [shownGraph, fit, page, restoreView, hasUserMoved, setGlanceView]);");
    // derived from crateDATA — the graph genuinely on screen — never from crateNode, the intent
    expect(src).toContain("const shownGraph = crateData ? `crate:${crateNode}` : featureData ? `feature:${featureNode}` : drill ? `drill:${drill}` : \"network\";");
  });

  it("the crate graph clears in the SAME render the layer closes", () => {
    // `crateDoc` is cleared by an effect, which runs AFTER the render where `crateNode` became null. For
    // that one render the layer was closed while the model still held the crate graph, and that stale
    // render is what the viewport was framed against on the way out.
    //
    // The GUARD is what this pins, not the call. It was written against the literal
    // `crateDrillGraph(crateDoc)` and so went red when the crate drill gained its liveness overlay
    // (`the-crate-drill-shows-its-sessions-live`) — a green-to-red on a change that preserved the
    // property exactly. Asserting the condition keeps the claim and stops the test owning which fold
    // the memo calls, which is a different test's business.
    expect(src).toContain("crateNode && crateDoc ?");
    expect(src).toMatch(/\[crateNode, crateDoc[,\]]/);
  });
});
