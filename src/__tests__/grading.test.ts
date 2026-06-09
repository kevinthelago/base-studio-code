import { describe, it, expect } from "vitest";
import {
  scoreContentRule, gradeWithRubric, rubricForSection, RUBRICS, type Rubric,
} from "../screens/projects/grading";

describe("grading — content rules (#615)", () => {
  it("min-length scales toward the target", () => {
    expect(scoreContentRule({ rule: "min-length", chars: 100 }, "")).toBe(0);
    expect(scoreContentRule({ rule: "min-length", chars: 100 }, "x".repeat(50))).toBe(50);
    expect(scoreContentRule({ rule: "min-length", chars: 100 }, "x".repeat(200))).toBe(100);
  });
  it("has-structure detects headings / bullets / numbered lists", () => {
    expect(scoreContentRule({ rule: "has-structure" }, "## Title\nbody")).toBe(100);
    expect(scoreContentRule({ rule: "has-structure" }, "- a\n- b")).toBe(100);
    expect(scoreContentRule({ rule: "has-structure" }, "1. step")).toBe(100);
    expect(scoreContentRule({ rule: "has-structure" }, "just prose")).toBe(0);
  });
  it("no-placeholders fails on TODO/??? ", () => {
    expect(scoreContentRule({ rule: "no-placeholders" }, "all done")).toBe(100);
    expect(scoreContentRule({ rule: "no-placeholders" }, "TODO: fill this")).toBe(0);
    expect(scoreContentRule({ rule: "no-placeholders" }, "value = ???")).toBe(0);
  });
  it("mentions scores the share of key terms present", () => {
    expect(scoreContentRule({ rule: "mentions", any: ["alpha", "beta", "gamma", "delta"] }, "has alpha and beta")).toBe(50);
    expect(scoreContentRule({ rule: "mentions", any: ["endpoint"] }, "the ENDPOINT is /x")).toBe(100);
    expect(scoreContentRule({ rule: "mentions", any: [] }, "")).toBe(100);
  });
});

describe("grading — gradeWithRubric (#615)", () => {
  it("weighted-averages dimensions, derives letter, and flags weak ones", () => {
    const r: Rubric = {
      id: "t", label: "T", sectionKey: "x", dimensions: [
        { id: "len", label: "Length", content: { rule: "min-length", chars: 100 } },
        { id: "ph", label: "No placeholders", content: { rule: "no-placeholders" }, hint: "Remove TODOs" },
      ],
    };
    const res = gradeWithRubric(r, { sectionKey: "x", signals: {}, content: "x".repeat(100) }); // len=100, ph=100
    expect(res.score).toBe(100);
    expect(res.letter).toBe("A");
    expect(res.findings).toHaveLength(0);

    const weak = gradeWithRubric(r, { sectionKey: "x", signals: {}, content: "TODO" }); // len≈4, ph=0
    expect(weak.score).toBeLessThan(50);
    expect(weak.letter).toBe("F");
    expect(weak.findings.some((f) => f.severity === "error" && /TODO/.test(f.message))).toBe(true);
  });

  it("scores a signal dimension from evalGate", () => {
    const r: Rubric = {
      id: "s", label: "S", sectionKey: "structure", dimensions: [
        { id: "ready", label: "Ready", signal: { require: [{ signal: "issuesReady", target: true }] } },
      ],
    };
    expect(gradeWithRubric(r, { sectionKey: "structure", signals: { issuesReady: true } }).score).toBe(100);
    expect(gradeWithRubric(r, { sectionKey: "structure", signals: { issuesReady: false } }).score).toBe(0);
  });
});

describe("grading — rubric registry (#615)", () => {
  it("has a rubric per known section kind, and a generic fallback", () => {
    for (const k of ["context", "scope", "stack", "architecture", "schema", "api", "ui", "structure", "permissions", "testing", "security"]) {
      expect(RUBRICS[k]).toBeTruthy();
      expect(rubricForSection(k).id).toBe(`rubric:${k}`);
    }
    expect(rubricForSection("unknown-kind").id).toBe("rubric:*");
  });

  it("a thin context section grades poorly; a complete one grades well", () => {
    const thin = gradeWithRubric(rubricForSection("context"), { sectionKey: "context", signals: {}, content: "TODO" });
    expect(thin.letter === "F" || thin.letter === "D").toBe(true);
    const good = gradeWithRubric(rubricForSection("context"), {
      sectionKey: "context", signals: {},
      content: "## Goal\nShip X. " + "Detail. ".repeat(40) + "Our success criteria and key constraint are defined.",
    });
    expect(good.score).toBeGreaterThan(80);
  });
});
