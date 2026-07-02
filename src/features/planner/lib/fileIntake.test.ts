import { describe, it, expect } from "vitest";
import {
  classifyFile, isBinaryKind, intakeEntry, mergeIntake, serializeIntake, parseIntake,
  hashContent, changedDesignFiles, markRouted, renderDesignDelta,
  INTAKE_DIR, INTAKE_MANIFEST,
} from "./fileIntake";
import { STAGE_DEFS } from "../stages/blueprints";

describe("fileIntake — staging directory (#829)", () => {
  it("stages dropped files into a visible project-folder design/ directory", () => {
    expect(INTAKE_DIR).toBe("design");
    expect(INTAKE_MANIFEST).toBe("design/intake.json");
    // the UI stage's route prompt (now data — ui.json → routePrompt) points the planner at the same dir
    expect(STAGE_DEFS.ui.routePrompt).toContain("design/");
    expect(STAGE_DEFS.ui.routePrompt).not.toContain(".intake");
  });
});

describe("fileIntake — classify (#604)", () => {
  it("classifies by extension", () => {
    expect(classifyFile("hero.png")).toBe("image");
    expect(classifyFile("icon.svg")).toBe("vector");
    expect(classifyFile("Card.tsx")).toBe("component");
    expect(classifyFile("page.html")).toBe("markup");
    expect(classifyFile("theme.css")).toBe("style");
    expect(classifyFile("tokens.json")).toBe("data");
    expect(classifyFile("spec.md")).toBe("doc");
    expect(classifyFile("mystery.xyz")).toBe("other");
    expect(classifyFile("noext")).toBe("other");
  });

  it("falls back to MIME family when the extension is unknown", () => {
    expect(classifyFile("blob", "image/png")).toBe("image");
    expect(classifyFile("blob", "image/svg+xml")).toBe("vector");
    expect(classifyFile("blob", "text/html")).toBe("markup");
    expect(classifyFile("blob", "application/json")).toBe("data");
    expect(classifyFile("blob", "text/plain")).toBe("doc");
  });

  it("extension wins over MIME", () => {
    expect(classifyFile("Card.tsx", "text/plain")).toBe("component");
  });

  it("isBinaryKind routes images/other to the binary writer", () => {
    expect(isBinaryKind("image")).toBe(true);
    expect(isBinaryKind("other")).toBe(true);
    expect(isBinaryKind("component")).toBe(false);
    expect(isBinaryKind("vector")).toBe(false); // svg is text
  });
});

describe("fileIntake — manifest (#604)", () => {
  it("builds an entry with kind + hash + optional mime", () => {
    expect(intakeEntry("hero.png", 1234, "h1", "image/png")).toEqual({ name: "hero.png", kind: "image", size: 1234, hash: "h1", mime: "image/png" });
    expect(intakeEntry("a.tsx", 10, "h2")).toEqual({ name: "a.tsx", kind: "component", size: 10, hash: "h2" });
  });

  it("merges de-duping by name (newest wins), then round-trips through serialize/parse", () => {
    const a = [intakeEntry("hero.png", 1, "a1"), intakeEntry("a.tsx", 2, "a2")];
    const b = [intakeEntry("hero.png", 99, "b1", "image/png"), intakeEntry("b.css", 3, "b3")];
    const merged = mergeIntake(a, b);
    expect(merged.map((e) => e.name)).toEqual(["hero.png", "a.tsx", "b.css"]);
    expect(merged.find((e) => e.name === "hero.png")!.size).toBe(99); // newest wins
    expect(parseIntake(serializeIntake(merged))).toEqual(merged);
  });

  it("parseIntake is tolerant and defaults hash to empty", () => {
    expect(parseIntake("")).toEqual([]);
    expect(parseIntake("{not json")).toEqual([]);
    expect(parseIntake('{"a":1}')).toEqual([]); // not an array
    expect(parseIntake('[{"name":"x.png"}]')).toEqual([{ name: "x.png", kind: "other", size: 0, hash: "" }]);
  });
});

describe("fileIntake — change-aware routing (#2097)", () => {
  it("hashContent is deterministic and content-sensitive", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
  });

  it("mergeIntake preserves a prior routedHash on a re-drop (so an edit is detectable)", () => {
    // First staged + routed at content hash "v1".
    const staged = markRouted([intakeEntry("hero.png", 1, "v1")]);
    expect(staged[0].routedHash).toBe("v1");
    // Re-drop the SAME file, now edited → new content hash "v2".
    const merged = mergeIntake(staged, [intakeEntry("hero.png", 2, "v2")]);
    expect(merged[0].hash).toBe("v2");
    expect(merged[0].routedHash).toBe("v1"); // last-routed preserved
  });

  it("changedDesignFiles returns new + edited files, not unchanged ones", () => {
    const entries = [
      intakeEntry("new.png", 1, "n1"),                              // never routed → changed
      { ...intakeEntry("edited.svg", 2, "e2"), routedHash: "e1" },  // hash ≠ routedHash → changed
      { ...intakeEntry("same.css", 3, "s1"), routedHash: "s1" },   // hash = routedHash → unchanged
    ];
    expect(changedDesignFiles(entries).map((e) => e.name)).toEqual(["new.png", "edited.svg"]);
  });

  it("markRouted stamps every entry as routed at its current content", () => {
    const routed = markRouted([intakeEntry("a.png", 1, "a1"), intakeEntry("b.png", 2, "b1")]);
    expect(changedDesignFiles(routed)).toEqual([]); // nothing changed after a route
  });

  it("renderDesignDelta leads with the changed files (empty when nothing changed)", () => {
    expect(renderDesignDelta([], "ROUTE")).toBe("");
    const lead = renderDesignDelta([intakeEntry("hero.png", 1, "h1")], "ROUTE-INSTRUCTION");
    expect(lead).toContain("hero.png");
    expect(lead).toContain("ROUTE-INSTRUCTION");
    expect(lead).toMatch(/1 design file/);
  });
});
