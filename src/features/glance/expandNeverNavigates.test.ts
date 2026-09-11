// EXPANDING A NODE NEVER LEAVES GLANCE (`expanding-a-node-never-navigates-to-the-console`).
//
// THE DEFECT THIS CLOSES. Clicking a node with no live pane and no open build tab fell through to
// `resumeProjectFleet`, whose `fleetStartProject` — in `resumeProject.ts`'s own words — "navigates to
// the Console and focuses the build tab". So looking at ONE node threw the user off the graph AND
// relaunched every other stream on the way. On studio-code's drill that is 60 surface streams, and it
// made the lexicographer and every un-started surface read as broken.
//
// WHY A SOURCE SCAN. The decision is already covered by `decideExpand`'s unit tests — the bug was never
// in the decision, it was in what the CALLER did with its last branch. Rendering a whole drilled fleet
// to assert "and then it did not change workspace" is the expensive kind of test this codebase warns
// about, green for reasons unrelated to the claim. What has to hold is that the workspace owns no path
// to the fleet relaunch or to a Console switch at all, and that is a fact about the source.
import { describe, it, expect } from "vitest";
import { loadStore } from "@scripts/lib/recordStore.mjs";

// The CALL and the IMPORT, not the word. The comments in that record name `resumeProjectFleet` to
// explain why it is gone, and a guard that cannot tell an explanation from a call would force the
// next reader to delete the explanation to keep the gate green.
const BANNED: readonly [string, RegExp][] = [
  ["a call to resumeProjectFleet", /\bresumeProjectFleet\s*\(/],
  ["an import of resumeProjectFleet", /import\s*\{[^}]*\bresumeProjectFleet\b[^}]*\}/],
  ["a switch to the Console", /setWorkspace\s*\(\s*["'`]console["'`]\s*\)/],
];

describe("the Glance workspace cannot navigate to the Console", () => {
  const rec = (loadStore("graph/components.db").implementations ?? []).find(
    (r: { id?: string }) => r.id === "glancepage",
  ) as { srcText?: string } | undefined;
  const src = rec?.srcText ?? "";

  it("reads the glancepage record, so the assertions below are not vacuous", () => {
    // An empty body would satisfy every `not.toContain` below perfectly.
    expect(src.length).toBeGreaterThan(10_000);
    expect(src).toContain("decideExpand");
  });

  it.each(BANNED)("never reaches %s", (_label, pattern) => {
    expect(src).not.toMatch(pattern);
  });
});
