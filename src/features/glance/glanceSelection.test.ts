// Text selection on the graph: OFF everywhere, ON inside a live terminal.
//
// Two rules that only make sense together, which is why they are pinned together:
//
//  1. The canvas viewport sets `user-select: none`, so a click or a pan-drag never paints a blue smear
//     across node labels, edge text, the legend or the hint strip. #2527 put this on the WORLD layer;
//     it is on the viewport now, because the overlays are drawn inside the viewport but outside the
//     world and were still selectable.
//
//  2. A terminal morph opts back IN. It is a world-layer CHILD — it grows in place inside the graph
//     rather than portalling out — so it inherited the block, and the one surface where selecting text
//     is the entire point could not be selected. Copying a stack trace out of a session meant reading
//     it off the screen.
//
// Neither is safe alone: rule 1 without rule 2 breaks the terminal, and rule 2 without rule 1 is
// pointless. jsdom computes no cascade, so this asserts the SOURCE — which is the honest thing it can
// check, and enough to catch either half being dropped.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const CSS = readFileSync("src/features/glance/glance.css", "utf8");
const CANVAS_CSS = readFileSync("src/shared/ui/layouts/graphCanvas.css", "utf8");
/** The shared canvas as it SHIPS — a record, so the packaged copy is what actually mounts. */
const CANVAS: string = JSON.parse(
  readFileSync("src-tauri/data/components/app/shared/ui/ui-graph-canvas.json", "utf8"),
).srcText;
/** Likewise the rail: `.graph-rail` has to be on the element the CSS targets, or the rule hits nothing. */
const RAIL: string = JSON.parse(
  readFileSync("src-tauri/data/components/app/shared/ui/ui-graph-rail.json", "utf8"),
).srcText;

describe("graph selection (#2527 + the terminal carve-out)", () => {
  it("the canvas viewport blocks selection", () => {
    // On the viewport element — the one that also contains the untransformed overlays.
    expect(CANVAS).toMatch(/userSelect:\s*"none"/);
  });

  it("still blocks it on the world layer, so a pan over nodes selects nothing", () => {
    // Both remain: the world layer's own rule is what #2527 shipped and what covers the node cards.
    const world = CANVAS.slice(CANVAS.indexOf("ref={setWorld}"));
    expect(world.slice(0, 400)).toMatch(/userSelect:\s*"none"/);
  });

  it("a live terminal is selectable again", () => {
    expect(CSS).toMatch(/\.glance-card \.xterm[^{]*\{[^}]*user-select:\s*text/);
    // WebKit needs the prefixed form too; without it the carve-out silently does nothing there, which
    // is the platform the app actually ships on.
    expect(CSS).toMatch(/\.glance-card \.xterm[^{]*\{[^}]*-webkit-user-select:\s*text/);
  });

  it("uses `text`, not `auto` — `auto` under a `none` ancestor still computes to none", () => {
    // The terminal's ancestor IS `none` (the world layer), so `auto` would inherit the block and the
    // carve-out would read as correct while doing nothing.
    const rule = CSS.slice(CSS.indexOf(".glance-card .xterm"));
    expect(rule.slice(0, rule.indexOf("}"))).not.toMatch(/user-select:\s*auto/);
  });

  it("carves out the TERMINAL, not the whole card — a preview morph is not selectable", () => {
    // `.glance-card` is also what a preview morph renders into. Scoping to xterm keeps the exception to
    // what was actually asked for, and follows the terminal wherever it is mounted.
    const rule = CSS.slice(CSS.indexOf(".glance-card .xterm"));
    const selector = rule.slice(0, rule.indexOf("{"));
    expect(selector).toContain(".xterm");
  });
});

// The LEFT RAIL, added after the fact. 3005dc42 deliberately left rail/toolbar/inspector selectable;
// the maintainer then asked for the left pane to be included. Only the LEFT one — the toolbar and the
// right-hand inspector keep the original behaviour, so this suite has to pin the boundary too, or
// "include the left pane" quietly becomes "include everything" on the next edit.
describe("the graph's left rail is not selectable either", () => {
  it("blocks selection across the rail", () => {
    expect(CANVAS_CSS).toMatch(/\.graph-rail\s*\{[^}]*user-select:\s*none/);
  });

  it("carries the -webkit- prefix, or it is inert on the platform this ships on", () => {
    expect(CANVAS_CSS).toMatch(/\.graph-rail\s*\{[^}]*-webkit-user-select:\s*none/);
  });

  it("carves the form fields back out — the rail LEADS with a search box", () => {
    // Glance puts a SearchField in the rail's `tools` slot. Under a `none` ancestor WebKit makes the
    // text inside an input unselectable: no caret drag, no copying out of your own search box.
    expect(CANVAS_CSS).toMatch(/\.graph-rail input[^{]*\{[^}]*user-select:\s*text/);
    expect(CANVAS_CSS).toMatch(/\.graph-rail input[^{]*\{[^}]*-webkit-user-select:\s*text/);
  });

  it("uses `text`, not `auto`, for that carve-out — the same trap as the terminal's", () => {
    const rule = CANVAS_CSS.slice(CANVAS_CSS.indexOf(".graph-rail input"));
    expect(rule.slice(0, rule.indexOf("}"))).not.toMatch(/user-select:\s*auto/);
  });

  it("puts the class on GraphRail's own root, not on a GraphCanvas wrapper", () => {
    // GraphCanvas renders `rail` BARE unless `railResizable` is set, and only wraps it in a Box when it
    // is. A wrapper-side rule would cover Glance (resizable) and silently miss every other graph.
    expect(RAIL).toMatch(/className="graph-rail"/);
  });

  it("does NOT widen to the toolbar or the right-hand inspector", () => {
    // Those two stay selectable on purpose — 3005dc42's reasoning holds for them, and only the left
    // pane was asked for. A `.graph-inspector`/toolbar rule appearing here is scope creep, not a fix.
    expect(CANVAS_CSS).not.toMatch(/\.graph-inspector\s*\{[^}]*user-select:\s*none/);
  });
});
