import { describe, it, expect } from "vitest";
import { parsePlanFocus, stripPlanFocus, buildSectionConfirmMessage } from "../screens/projects/planningSession";

describe("parsePlanFocus", () => {
  it("extracts the section key from a focus tag", () => {
    expect(parsePlanFocus('<plan_focus section="goal" />')).toEqual(["goal"]);
  });

  it("extracts multiple keys in order of appearance", () => {
    const text = 'before <plan_focus section="goal" /> mid <plan_focus section="scope" /> after';
    expect(parsePlanFocus(text)).toEqual(["goal", "scope"]);
  });

  it("tolerates curly smart quotes", () => {
    expect(parsePlanFocus("<plan_focus section=“stack” />")).toEqual(["stack"]);
  });

  it("returns [] when no focus tag is present", () => {
    expect(parsePlanFocus("just some terminal output")).toEqual([]);
  });

  it("ignores other planner tags", () => {
    expect(parsePlanFocus('<plan_update section="goal">x</plan_update>')).toEqual([]);
  });
});

describe("stripPlanFocus", () => {
  it("removes focus tags from the buffer", () => {
    const text = 'a <plan_focus section="goal" /> b <plan_focus section="scope" /> c';
    expect(stripPlanFocus(text)).toBe("a  b  c");
  });

  it("leaves text without focus tags untouched", () => {
    expect(stripPlanFocus("nothing to strip")).toBe("nothing to strip");
  });
});

describe("buildSectionConfirmMessage", () => {
  it("references the section title and instructs to continue", () => {
    const msg = buildSectionConfirmMessage("Goal");
    expect(msg).toContain('"Goal"');
    expect(msg.toLowerCase()).toContain("continue to the next section");
  });

  it("is a single line (no embedded newline that would submit early)", () => {
    expect(buildSectionConfirmMessage("API")).not.toContain("\n");
  });
});
