import { describe, it, expect } from "vitest";
import {
  classifyFile, isBinaryKind, intakeEntry, mergeIntake, serializeIntake, parseIntake,
  INTAKE_DIR, INTAKE_MANIFEST, ROUTE_PROMPT,
} from "./fileIntake";

describe("fileIntake — staging directory (#829)", () => {
  it("stages dropped files into a visible project-folder design/ directory", () => {
    expect(INTAKE_DIR).toBe("design");
    expect(INTAKE_MANIFEST).toBe("design/intake.json");
    // the route prompt points the planner at the same visible directory
    expect(ROUTE_PROMPT).toContain("design/");
    expect(ROUTE_PROMPT).not.toContain(".intake");
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
  it("builds an entry with kind + optional mime", () => {
    expect(intakeEntry("hero.png", 1234, "image/png")).toEqual({ name: "hero.png", kind: "image", size: 1234, mime: "image/png" });
    expect(intakeEntry("a.tsx", 10)).toEqual({ name: "a.tsx", kind: "component", size: 10 });
  });

  it("merges de-duping by name (newest wins), then round-trips through serialize/parse", () => {
    const a = [intakeEntry("hero.png", 1), intakeEntry("a.tsx", 2)];
    const b = [intakeEntry("hero.png", 99, "image/png"), intakeEntry("b.css", 3)];
    const merged = mergeIntake(a, b);
    expect(merged.map((e) => e.name)).toEqual(["hero.png", "a.tsx", "b.css"]);
    expect(merged.find((e) => e.name === "hero.png")!.size).toBe(99); // newest wins
    expect(parseIntake(serializeIntake(merged))).toEqual(merged);
  });

  it("parseIntake is tolerant", () => {
    expect(parseIntake("")).toEqual([]);
    expect(parseIntake("{not json")).toEqual([]);
    expect(parseIntake('{"a":1}')).toEqual([]); // not an array
    expect(parseIntake('[{"name":"x.png"}]')).toEqual([{ name: "x.png", kind: "other", size: 0 }]);
  });
});
