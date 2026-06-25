import { describe, it, expect } from "vitest";
import { plannerIntroMode, composePlannerIntro, plannerTreatAsExisting } from "./plannerIntro";

describe("plannerIntro — mode selection (#1240)", () => {
  it("authoring → blueprint, existing project → existing, else new", () => {
    expect(plannerIntroMode({ isAuthoring: true, isExisting: false })).toBe("blueprint");
    expect(plannerIntroMode({ isAuthoring: true, isExisting: true })).toBe("blueprint"); // authoring wins
    expect(plannerIntroMode({ isAuthoring: false, isExisting: true })).toBe("existing");
    expect(plannerIntroMode({ isAuthoring: false, isExisting: false })).toBe("new");
  });
});

describe("plannerTreatAsExisting — orientation follows blueprint mode (#1286)", () => {
  it("an operate-mode blueprint is 'existing' even on a fresh draft (the switch bug)", () => {
    // Draft (not saved) + operate lifecycle (transform/harden/maintain) → existing orientation.
    expect(plannerTreatAsExisting({ isSaved: false, mode: "operate" })).toBe(true);
  });
  it("a create-mode draft stays a new greenfield project", () => {
    expect(plannerTreatAsExisting({ isSaved: false, mode: "create" })).toBe(false);
    expect(plannerTreatAsExisting({ isSaved: false, mode: undefined })).toBe(false); // absent ⇒ create
  });
  it("a saved project stays 'existing' regardless of mode (no behavior change for saved projects)", () => {
    expect(plannerTreatAsExisting({ isSaved: true, mode: "create" })).toBe(true);
    expect(plannerTreatAsExisting({ isSaved: true, mode: "operate" })).toBe(true);
  });
  it("composes with plannerIntroMode: a just-switched draft transform gets the existing intro", () => {
    const treat = plannerTreatAsExisting({ isSaved: false, mode: "operate" });
    expect(plannerIntroMode({ isAuthoring: false, isExisting: treat })).toBe("existing");
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
