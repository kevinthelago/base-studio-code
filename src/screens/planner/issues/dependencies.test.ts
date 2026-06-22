import { describe, it, expect } from "vitest";
import {
  parseDependenciesFile, depsForRepo, bucketByEcosystem,
  mergeIntoPackageJson, mergeIntoCargoToml, buildWorkerDependencyBlock,
  type PlanDependency,
} from "./dependencies";

describe("parseDependenciesFile (#1111)", () => {
  it("parses a bare array, keeping only npm/cargo entries with a name", () => {
    const deps = parseDependenciesFile(JSON.stringify([
      { repo: "a/web", ecosystem: "npm", name: "zod", version: "^3.23", why: "validation" },
      { ecosystem: "cargo", name: "serde", version: "1" },
      { ecosystem: "pip", name: "requests" }, // dropped — unsupported ecosystem
      { ecosystem: "npm" },                    // dropped — no name
    ]));
    expect(deps).toHaveLength(2);
    expect(deps[0]).toMatchObject({ repo: "a/web", ecosystem: "npm", name: "zod", version: "^3.23", why: "validation" });
    expect(deps[1]).toMatchObject({ ecosystem: "cargo", name: "serde" });
  });

  it("accepts the { dependencies: [...] } wrapper and dedupes by repo+ecosystem+name", () => {
    const deps = parseDependenciesFile(JSON.stringify({ dependencies: [
      { ecosystem: "npm", name: "react", version: "18" },
      { ecosystem: "npm", name: "React", version: "19" }, // same name (case-insensitive) — first wins
    ] }));
    expect(deps).toHaveLength(1);
    expect(deps[0].version).toBe("18");
  });

  it("is tolerant of blank/garbage input", () => {
    expect(parseDependenciesFile("")).toEqual([]);
    expect(parseDependenciesFile("not json")).toEqual([]);
    expect(parseDependenciesFile("42")).toEqual([]);
  });

  it("marks dev dependencies", () => {
    const deps = parseDependenciesFile(JSON.stringify([{ ecosystem: "npm", name: "vitest", dev: true }]));
    expect(deps[0].dev).toBe(true);
  });
});

describe("depsForRepo (#1111)", () => {
  const deps: PlanDependency[] = [
    { repo: "a/web", ecosystem: "npm", name: "zod" },
    { repo: "a/api", ecosystem: "cargo", name: "serde" },
    { ecosystem: "npm", name: "typescript", dev: true }, // unscoped ⇒ every repo
  ];
  it("returns repo-scoped deps plus the unscoped ones", () => {
    expect(depsForRepo(deps, "a/web").map(d => d.name)).toEqual(["zod", "typescript"]);
    expect(depsForRepo(deps, "a/api").map(d => d.name)).toEqual(["serde", "typescript"]);
  });
  it("buckets by ecosystem", () => {
    const b = bucketByEcosystem(depsForRepo(deps, "a/web"));
    expect(b.npm.map(d => d.name)).toEqual(["zod", "typescript"]);
    expect(b.cargo).toEqual([]);
  });
});

describe("mergeIntoPackageJson (#1111)", () => {
  it("creates a minimal private package when none exists", () => {
    const out = mergeIntoPackageJson(null, "my-app", [
      { ecosystem: "npm", name: "zod", version: "^3.23" },
      { ecosystem: "npm", name: "vitest", version: "^2.0", dev: true },
    ])!;
    const json = JSON.parse(out);
    expect(json).toMatchObject({ name: "my-app", version: "0.1.0", private: true });
    expect(json.dependencies).toEqual({ zod: "^3.23" });
    expect(json.devDependencies).toEqual({ vitest: "^2.0" });
  });

  it("additively merges without clobbering a pinned version", () => {
    const existing = JSON.stringify({ name: "app", dependencies: { react: "18.2.0" } }, null, 2);
    const out = mergeIntoPackageJson(existing, "app", [
      { ecosystem: "npm", name: "react", version: "19" }, // already present — keep 18.2.0
      { ecosystem: "npm", name: "zod", version: "^3" },   // new — added
    ])!;
    const json = JSON.parse(out);
    expect(json.dependencies.react).toBe("18.2.0");
    expect(json.dependencies.zod).toBe("^3");
  });

  it("returns null when there are no npm deps or the existing file is unparseable", () => {
    expect(mergeIntoPackageJson(null, "app", [{ ecosystem: "cargo", name: "serde" }])).toBeNull();
    expect(mergeIntoPackageJson("{ not json", "app", [{ ecosystem: "npm", name: "zod" }])).toBeNull();
  });
});

describe("mergeIntoCargoToml (#1111)", () => {
  it("generates a minimal valid manifest when none exists", () => {
    const out = mergeIntoCargoToml(null, "my-api", [
      { ecosystem: "cargo", name: "serde", version: "1" },
      { ecosystem: "cargo", name: "proptest", version: "1", dev: true },
    ])!;
    expect(out).toContain("[package]");
    expect(out).toContain(`name = "my-api"`);
    expect(out).toContain("[dependencies]");
    expect(out).toContain(`serde = "1"`);
    expect(out).toContain("[dev-dependencies]");
    expect(out).toContain(`proptest = "1"`);
  });

  it("appends a missing dep into an existing [dependencies] table, leaving present ones untouched", () => {
    const existing = `[package]\nname = "api"\n\n[dependencies]\nserde = "1.0.200"\n`;
    const out = mergeIntoCargoToml(existing, "api", [
      { ecosystem: "cargo", name: "serde", version: "1" }, // present — not duplicated/clobbered
      { ecosystem: "cargo", name: "tokio", version: "1.35" }, // new — appended
    ])!;
    expect(out).toContain(`serde = "1.0.200"`);
    expect(out).not.toContain(`serde = "1"`);
    expect(out).toContain(`tokio = "1.35"`);
    expect(out.match(/serde =/g)).toHaveLength(1);
  });

  it("returns null when there are no cargo deps", () => {
    expect(mergeIntoCargoToml(null, "api", [{ ecosystem: "npm", name: "zod" }])).toBeNull();
  });
});

describe("buildWorkerDependencyBlock (#1111)", () => {
  it("renders the locked set with the don't-edit guardrail", () => {
    const md = buildWorkerDependencyBlock([
      { ecosystem: "npm", name: "zod", version: "^3.23", why: "validation" },
      { ecosystem: "cargo", name: "serde", version: "1", dev: false },
      { ecosystem: "npm", name: "vitest", dev: true },
    ]);
    expect(md).toContain("## Dependencies (locked by the planner)");
    expect(md).toContain("`zod@^3.23`");
    expect(md).toContain("validation");
    expect(md).toContain("`serde@1`");
    expect(md).toContain("*(dev)*");
    expect(md).toMatch(/Do NOT add to or\s*\n?\s*edit/);
    expect(md).toContain("bsc-ask");
  });

  it("is empty when the repo has no locked deps", () => {
    expect(buildWorkerDependencyBlock([])).toBe("");
  });
});
