import { describe, it, expect } from "vitest";
import { planActions, applyAssistantActions, actionLine, proseFor } from "../screens/projects/blueprintAssistantCore";
import { mkStageSection } from "../screens/projects/blueprintEdit";

const base = () => [mkStageSection("context"), mkStageSection("stack")];

describe("blueprintAssistant — planActions (#609)", () => {
  it("maps a security request to an add", () => {
    const a = planActions("add a security review", base());
    expect(a).toEqual([{ op: "add", kind: "security" }]);
  });

  it("contract-first adds the schema + api stages (#897 Phase 4c: stages only, no pipelines)", () => {
    const a = planActions("make it contract-first with API gates", base());
    expect(a).toEqual([
      { op: "add", kind: "schema" },
      { op: "add", kind: "api" },
    ]);
  });

  it("UI request adds a ui stage, and is a no-op when it already exists", () => {
    expect(planActions("add a UI preview", base())).toEqual([{ op: "add", kind: "ui" }]);
    const withUi = [...base(), mkStageSection("ui")];
    expect(planActions("gate the UI design stage", withUi)).toEqual([]);
  });

  it("never duplicates an existing kind", () => {
    const withSec = [...base(), mkStageSection("security")];
    expect(planActions("add security", withSec)).toEqual([]);
  });

  it("MVP trims process stages that exist", () => {
    const heavy = [mkStageSection("context"), mkStageSection("observability"), mkStageSection("cicd")];
    expect(planActions("trim to a lean MVP", heavy)).toEqual([
      { op: "remove", kind: "observability" },
      { op: "remove", kind: "cicd" },
    ]);
  });
});

describe("blueprintAssistant — applyAssistantActions (#609)", () => {
  it("adds a stage", () => {
    const out = applyAssistantActions(base(), [{ op: "add", kind: "api" }]);
    expect(out.some((s) => s.key === "api")).toBe(true);
  });

  it("removes a stage", () => {
    const withSec = [...base(), mkStageSection("security")];
    const out = applyAssistantActions(withSec, [{ op: "remove", kind: "security" }]);
    expect(out.some((s) => s.key === "security")).toBe(false);
  });
});

describe("blueprintAssistant — prose + lines (#609)", () => {
  it("actionLine classifies", () => {
    expect(actionLine({ op: "add", kind: "security" }).type).toBe("add");
    expect(actionLine({ op: "remove", kind: "cicd" }).type).toBe("del");
    expect(actionLine({ op: "attach-skill", kind: "ui", skillId: "s1", skillName: "S1" }).type).toBe("mod");
  });
  it("proseFor summarizes counts, and handles empty", () => {
    expect(proseFor([])).toMatch(/couldn't map/);
    expect(proseFor([{ op: "add", kind: "api" }])).toMatch(/add 1 stage/);
  });
});
