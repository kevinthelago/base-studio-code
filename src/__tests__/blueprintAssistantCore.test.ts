import { describe, it, expect } from "vitest";
import { planActions, applyAssistantActions, actionLine, proseFor } from "../screens/projects/blueprintAssistantCore";
import { mkStageSection } from "../screens/projects/blueprintEdit";

const base = () => [mkStageSection("context"), mkStageSection("stack")];

describe("blueprintAssistant — planActions (#609)", () => {
  it("maps a security request to an add", () => {
    const a = planActions("add a security review", base());
    expect(a).toEqual([{ op: "add", kind: "security" }]);
  });

  it("contract-first adds schema + api with gate pipes", () => {
    const a = planActions("make it contract-first with API gates", base());
    expect(a).toEqual([
      { op: "add", kind: "schema", pipes: [["schema-check", true]] },
      { op: "add", kind: "api", pipes: [["contract-test", true]] },
    ]);
  });

  it("UI request gates render-preview when a UI stage already exists", () => {
    const withUi = [...base(), mkStageSection("ui")];
    expect(planActions("gate the UI design stage with render-preview", withUi)).toEqual([
      { op: "gatePipe", kind: "ui", pipeKey: "render-preview" },
    ]);
    // when absent it adds the stage
    expect(planActions("add a UI preview", base())).toEqual([
      { op: "add", kind: "ui", pipes: [["render-preview", true]] },
    ]);
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
  it("adds a stage with a gated pipeline", () => {
    const out = applyAssistantActions(base(), [{ op: "add", kind: "api", pipes: [["contract-test", true]] }]);
    const api = out.find((s) => s.key === "api")!;
    expect(api).toBeTruthy();
    expect(api.pipelines[0].id).toBe("contract-test");
    expect(api.pipelines[0].gate).toBe(true);
  });

  it("removes a stage", () => {
    const withSec = [...base(), mkStageSection("security")];
    const out = applyAssistantActions(withSec, [{ op: "remove", kind: "security" }]);
    expect(out.some((s) => s.key === "security")).toBe(false);
  });

  it("gatePipe adds the pipe gated when missing", () => {
    const withUi = [...base(), mkStageSection("ui")];
    const out = applyAssistantActions(withUi, [{ op: "gatePipe", kind: "ui", pipeKey: "render-preview" }]);
    const ui = out.find((s) => s.key === "ui")!;
    const rp = ui.pipelines.find((p) => p.id === "render-preview")!;
    expect(rp.gate).toBe(true);
  });
});

describe("blueprintAssistant — prose + lines (#609)", () => {
  it("actionLine classifies", () => {
    expect(actionLine({ op: "add", kind: "security" }).type).toBe("add");
    expect(actionLine({ op: "remove", kind: "cicd" }).type).toBe("del");
    expect(actionLine({ op: "gatePipe", kind: "ui", pipeKey: "render-preview" }).type).toBe("mod");
  });
  it("proseFor summarizes counts, and handles empty", () => {
    expect(proseFor([])).toMatch(/couldn't map/);
    expect(proseFor([{ op: "add", kind: "api", pipes: [["contract-test", true]] }])).toMatch(/add 1 stage/);
  });
});
