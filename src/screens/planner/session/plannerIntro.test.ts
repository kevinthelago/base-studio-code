import { describe, it, expect } from "vitest";
import { plannerIntroMode, composePlannerIntro } from "./plannerIntro";

describe("plannerIntro — mode selection (#1240)", () => {
  it("authoring → blueprint, existing project → existing, else new", () => {
    expect(plannerIntroMode({ isAuthoring: true, isExisting: false })).toBe("blueprint");
    expect(plannerIntroMode({ isAuthoring: true, isExisting: true })).toBe("blueprint"); // authoring wins
    expect(plannerIntroMode({ isAuthoring: false, isExisting: true })).toBe("existing");
    expect(plannerIntroMode({ isAuthoring: false, isExisting: false })).toBe("new");
  });
});

describe("plannerIntro — compose (#1240)", () => {
  it("appends the pitch only for a new project that has one", () => {
    const composed = composePlannerIntro("INTRO", "new", "build a todo app");
    expect(composed).toContain("INTRO");
    expect(composed).toContain("build a todo app");
  });

  it("ignores the pitch for non-new modes and when blank", () => {
    expect(composePlannerIntro("INTRO", "existing", "build a todo app")).toBe("INTRO");
    expect(composePlannerIntro("INTRO", "blueprint", "build a todo app")).toBe("INTRO");
    expect(composePlannerIntro("INTRO", "new", "   ")).toBe("INTRO");
  });

  it("an empty intro yields an empty prompt (launch falls back to initCmd)", () => {
    expect(composePlannerIntro("", "new", "x")).toBe("");
    expect(composePlannerIntro("   ", "existing", "")).toBe("");
  });
});
