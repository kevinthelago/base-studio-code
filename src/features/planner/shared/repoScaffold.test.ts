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

  it("uses the full goal for the Overview, falling back to the description (#1114)", () => {
    const overviewOnly = buildReadme(base);
    expect(overviewOnly).toContain("## Overview");
    expect(overviewOnly).toContain("A todo app for teams."); // falls back to description
    const withGoal = buildReadme({ ...base, goal: "A todo app for teams.\n\nIt syncs in real time across devices." });
    expect(withGoal).toContain("It syncs in real time across devices.");
  });

  it("renders a Scope section only when scope text is present (#1114)", () => {
    expect(buildReadme(base)).not.toContain("## Scope");
    expect(buildReadme({ ...base, scope: "In: tasks, lists. Out: billing." })).toContain("## Scope");
    expect(buildReadme({ ...base, scope: "In: tasks, lists. Out: billing." })).toContain("Out: billing.");
  });

  it("renders an Architecture section only when architecture text is present (#1114)", () => {
    expect(buildReadme(base)).not.toContain("## Architecture");
    expect(buildReadme({ ...base, architecture: "Client → API → Postgres." })).toContain("## Architecture");
  });

  it("renders a bulleted Features section from planned features, omitting empties (#1114)", () => {
    expect(buildReadme(base)).not.toContain("## Features");
    const md = buildReadme({ ...base, features: [
      { name: "Invite teammates", behavior: "send an email invite" },
      { name: "Dark mode" },
      { name: "   " }, // dropped — no name
    ] });
    expect(md).toContain("## Features");
    expect(md).toContain("- **Invite teammates** — send an email invite");
    expect(md).toContain("- **Dark mode**");
  });

  it("derives Getting-started commands from the stack, with a generic fallback (#1114)", () => {
    expect(buildReadme({ ...base, stackText: "React + TypeScript, Tauri (Rust)" }))
      .toContain("npm install");
    expect(buildReadme({ ...base, stackText: "React + TypeScript, Tauri (Rust)" }))
      .toContain("cargo build");
    expect(buildReadme(base)).toContain("install dependencies and run the project's");
  });

  it("always preserves the base-studio-code watermark (#1114)", () => {
    expect(buildReadme({ ...base, goal: "g", scope: "s", features: [{ name: "f" }] }))
      .toContain("_Scaffolded by base-studio-code._");
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
