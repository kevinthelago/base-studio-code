import { describe, it, expect } from "vitest";
import { deriveTopics, buildReadme, communityFiles } from "./repoScaffold";

describe("deriveTopics (#848)", () => {
  it("extracts stack topics from prose, lowercase-hyphenated", () => {
    const topics = deriveTopics("React 18 + TypeScript, bundled with Vite. Rust backend (Tauri).");
    expect(topics).toEqual(expect.arrayContaining(["react", "typescript", "vite", "rust", "tauri"]));
  });

  it("dedupes and caps at GitHub's 20-topic limit", () => {
    const extra = Array.from({ length: 30 }, (_, i) => `extra-${i}`);
    const topics = deriveTopics("rust rust rust", extra);
    expect(topics.length).toBeLessThanOrEqual(20);
    expect(topics.filter((t) => t === "rust").length).toBe(1);
  });

  it("normalizes explicit extras to topic slugs", () => {
    expect(deriveTopics("", ["Minecraft Mod", "CLI Tool"])).toEqual(["minecraft-mod", "cli-tool"]);
  });

  it("returns nothing for an unrecognized stack", () => {
    expect(deriveTopics("a bespoke in-house framework")).toEqual([]);
  });
});

describe("buildReadme (#848)", () => {
  const base = { fullName: "acme/web", description: "A todo app for teams." };

  it("includes title, description, license + last-commit badges", () => {
    const md = buildReadme(base);
    expect(md).toContain("# web");
    expect(md).toContain("A todo app for teams.");
    expect(md).toContain("img.shields.io/github/license/acme/web");
    expect(md).toContain("img.shields.io/github/last-commit/acme/web");
  });

  it("renders a CI status badge per workflow file", () => {
    const md = buildReadme({ ...base, workflows: ["ci.yml", "release.yml"] });
    expect(md).toContain("actions/workflows/ci.yml/badge.svg");
    expect(md).toContain("actions/workflows/release.yml/badge.svg");
  });

  it("omits CI badges gracefully when there are no workflows", () => {
    const md = buildReadme(base);
    expect(md).not.toContain("/badge.svg");
  });

  it("includes a Tech stack section only when stack text is present", () => {
    expect(buildReadme(base)).not.toContain("## Tech stack");
    expect(buildReadme({ ...base, stackText: "React + Rust" })).toContain("## Tech stack");
  });
});

describe("communityFiles (#848)", () => {
  it("emits the standard community-health files", () => {
    const paths = communityFiles("Acme").map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining([
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "SECURITY.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/ISSUE_TEMPLATE/bug_report.md",
      ".github/ISSUE_TEMPLATE/feature_request.md",
    ]));
  });

  it("parameterizes CONTRIBUTING by project name", () => {
    const contributing = communityFiles("Acme").find((f) => f.path === "CONTRIBUTING.md")!;
    expect(contributing.content).toContain("# Contributing to Acme");
  });
});
