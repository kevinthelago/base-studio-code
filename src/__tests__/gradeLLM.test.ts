import { describe, it, expect } from "vitest";
import { parseLLMGrade, gradeWithLLM, buildGradePrompt, GRADE_LLM_ID } from "../screens/projects/gradeLLM";
import { rubricForSection } from "../screens/projects/grading";

describe("gradeLLM — parseLLMGrade (#615 slice d)", () => {
  it("parses a valid JSON grade", () => {
    const raw = JSON.stringify({
      score: 82,
      dimensions: [{ label: "Clarity", score: 90, note: "clear goals" }, { label: "Feasibility", score: 74 }],
      findings: [{ severity: "warn", message: "Tighten the scope", fix: "drop X" }],
    });
    const r = parseLLMGrade(raw, "context");
    expect(r.graderId).toBe(GRADE_LLM_ID);
    expect(r.graderLabel).toBe("Claude review");
    expect(r.score).toBe(82);
    expect(r.letter).toBe("B");
    expect(r.dimensions.map((d) => d.label)).toEqual(["Clarity", "Feasibility"]);
    expect(r.findings[0]).toMatchObject({ severity: "warn", message: "Tighten the scope", fix: "drop X" });
  });

  it("extracts JSON even when wrapped in prose / code fences", () => {
    const raw = "Here is the grade:\n```json\n{\"score\": 50, \"dimensions\": [], \"findings\": []}\n```\nThanks!";
    const r = parseLLMGrade(raw, "api");
    expect(r.score).toBe(50);
    // no dimensions returned ⇒ a synthesized Overall row
    expect(r.dimensions).toEqual([{ id: "overall", label: "Overall", score: 50 }]);
  });

  it("clamps scores and normalizes bad severities", () => {
    const raw = JSON.stringify({ score: 130, dimensions: [{ label: "X", score: -5 }], findings: [{ severity: "boom", message: "m" }] });
    const r = parseLLMGrade(raw, "x");
    expect(r.score).toBe(100);
    expect(r.dimensions[0].score).toBe(0);
    expect(r.findings[0].severity).toBe("warn");
  });

  it("falls back to an error finding on unparseable output", () => {
    const r = parseLLMGrade("the model refused to answer", "x");
    expect(r.score).toBe(0);
    expect(r.letter).toBe("F");
    expect(r.findings[0].severity).toBe("error");
  });
});

describe("gradeLLM — gradeWithLLM + prompt (#615)", () => {
  it("builds a prompt naming the rubric dimensions + section content", () => {
    const p = buildGradePrompt(rubricForSection("api"), "api", "GET /things returns 200");
    expect(p.system).toMatch(/JSON/);
    expect(p.user).toMatch(/Section: api/);
    expect(p.user).toMatch(/GET \/things/);
  });

  it("runs through an injected completion", async () => {
    const complete = async () => '{"score": 95, "dimensions": [], "findings": []}';
    const r = await gradeWithLLM(rubricForSection("context"), { sectionKey: "context", content: "x" }, complete);
    expect(r.score).toBe(95);
    expect(r.letter).toBe("A");
  });
});
