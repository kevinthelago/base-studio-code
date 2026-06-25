import { describe, it, expect } from "vitest";
import {
  parseDependenciesFile, parseDependencyManifest, depsForRepo, bucketByEcosystem,
  mergeIntoPackageJson, mergeIntoCargoToml, buildNpmrc, buildCargoConfig, buildWorkerDependencyBlock,
  groupDependenciesBySource, sharedRepoDependencies, unlockedSharedRepos,
  type PlanDependency, type DependencyRegistry,
} from "./dependencies";

describe("sharedRepoDependencies (#1429 — Streams pane per-stream view)", () => {
  const registries: Record<string, DependencyRegistry> = {
    acme: { url: "npm.acme.internal", scope: "@acme", auth: "ACME_NPM_TOKEN" },
  };
  const deps: PlanDependency[] = [
    { repo: "acme/web", ecosystem: "npm", name: "zod", version: "3.23.8", stream: "api", why: "validators" },
    { repo: "acme/web", ecosystem: "npm", name: "@acme/api-client", source: "acme", stream: "api" },
    { repo: "acme/web", ecosystem: "npm", name: "react", version: "18.3.1", stream: "ui" },
    { repo: "acme/web", ecosystem: "npm", name: "zod", version: "3.23.8", stream: "ui" }, // shared with api
    { repo: "acme/web", ecosystem: "npm", name: "vitest", dev: true, stream: "ui" },
    { repo: "acme/cli", ecosystem: "cargo", name: "clap", stream: "infra" }, // single-owner repo
  ];
  const repoStreams = { "acme/web": ["api", "ui", "director"], "acme/cli": ["infra"] };

  it("includes only repos built by 2+ streams; single-owner repos are omitted", () => {
    const views = sharedRepoDependencies(deps, registries, repoStreams);
    expect(views.map((v) => v.repo)).toEqual(["acme/web"]);
  });

  it("groups deps per declaring stream, with an empty group for a no-dep owner (director)", () => {
    const [web] = sharedRepoDependencies(deps, registries, repoStreams);
    const byName = Object.fromEntries(web.byStream.map((g) => [g.stream, g]));
    expect(byName.api.deps.map((d) => d.name).sort()).toEqual(["@acme/api-client", "zod"]);
    expect(byName.ui.deps.map((d) => d.name).sort()).toEqual(["react", "vitest", "zod"]);
    expect(byName.director.empty).toBe(true);
    expect(web.total).toBe(5);
  });

  it("derives the version-lock: a package declared by 2+ streams flags sharedWith the others", () => {
    const [web] = sharedRepoDependencies(deps, registries, repoStreams);
    const apiZod = web.byStream.find((g) => g.stream === "api")!.deps.find((d) => d.name === "zod")!;
    const uiZod = web.byStream.find((g) => g.stream === "ui")!.deps.find((d) => d.name === "zod")!;
    expect(apiZod.sharedWith).toEqual(["ui"]);
    expect(uiZod.sharedWith).toEqual(["api"]);
    // react (ui only) isn't shared
    expect(web.byStream.find((g) => g.stream === "ui")!.deps.find((d) => d.name === "react")!.sharedWith).toEqual([]);
  });

  it("surfaces the repo's referenced registries (public + private)", () => {
    const [web] = sharedRepoDependencies(deps, registries, repoStreams);
    expect(web.registries.some((g) => !g.private)).toBe(true);            // npm public default
    expect(web.registries.some((g) => g.private && g.auth === "ACME_NPM_TOKEN")).toBe(true);
  });

  it("a multi-stream repo with no deps yet is included and flagged unlocked", () => {
    const rs = { "acme/web": ["api", "ui"] };
    expect(sharedRepoDependencies([], {}, rs).map((v) => v.repo)).toEqual(["acme/web"]);
    expect(unlockedSharedRepos([], rs)).toEqual(["acme/web"]);
    expect(unlockedSharedRepos(deps, rs)).toEqual([]); // acme/web now has deps
  });

  it("parses a stored `stream` field on a dependency", () => {
    const m = parseDependencyManifest(JSON.stringify({ dependencies: [{ repo: "a/b", ecosystem: "npm", name: "zod", stream: "api" }] }));
    expect(m.dependencies[0].stream).toBe("api");
  });
});

describe("groupDependenciesBySource (#1167 — Deploy pane)", () => {
  it("groups by source: ecosystem defaults for sourceless deps + one group per private registry", () => {
    const deps: PlanDependency[] = [
      { ecosystem: "npm", name: "zod", repo: "acme/web" },
      { ecosystem: "npm", name: "@acme/ui", repo: "acme/web", source: "internal" },
      { ecosystem: "cargo", name: "serde", repo: "acme/api" },
    ];
    const registries: Record<string, DependencyRegistry> = {
      internal: { url: "https://npm.internal/", scope: "@acme", auth: "TOK" },
    };
    const groups = groupDependenciesBySource(deps, registries);
    // public groups sort before the private one; defaults named after the ecosystem registry
    expect(groups.map((g) => g.key)).toEqual(["cargo", "npm", "internal"]);
    const npm = groups.find((g) => g.key === "npm")!;
    expect(npm.private).toBe(false);
    expect(npm.name).toBe("npm registry");
    expect(npm.deps.map((d) => d.name)).toEqual(["zod"]);
    const priv = groups.find((g) => g.key === "internal")!;
    expect(priv.private).toBe(true);
    expect(priv).toMatchObject({ url: "https://npm.internal/", scope: "@acme", auth: "TOK" });
    expect(priv.deps.map((d) => d.name)).toEqual(["@acme/ui"]);
  });

  it("falls back to the ecosystem default when a dep's source isn't a known registry", () => {
    const groups = groupDependenciesBySource([{ ecosystem: "npm", name: "x", source: "ghost" }], {});
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("npm");
    expect(groups[0].private).toBe(false);
  });
});

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

describe("parseDependencyManifest — sources + registries (#1127)", () => {
  it("parses the registries map and per-dep source", () => {
    const m = parseDependencyManifest(JSON.stringify({
      registries: { internal: { url: "https://npm.internal/", scope: "@acme", auth: "INTERNAL_NPM_TOKEN" } },
      dependencies: [{ ecosystem: "npm", name: "@acme/ui", version: "^2", source: "internal" }],
    }));
    expect(m.registries.internal).toEqual({ url: "https://npm.internal/", scope: "@acme", auth: "INTERNAL_NPM_TOKEN" });
    expect(m.dependencies[0].source).toBe("internal");
  });

  it("drops a registry without a string url", () => {
    const m = parseDependencyManifest(JSON.stringify({
      registries: { bad: { scope: "@x" }, ok: { url: "https://r/" } },
      dependencies: [],
    }));
    expect(m.registries.bad).toBeUndefined();
    expect(m.registries.ok).toBeTruthy();
  });

  it("is back-compatible with the #1111 bare-array form (no registries)", () => {
    const m = parseDependencyManifest(JSON.stringify([{ ecosystem: "npm", name: "zod" }]));
    expect(m.dependencies).toHaveLength(1);
    expect(m.registries).toEqual({});
  });

  it("parseDependenciesFile still returns just the list", () => {
    expect(parseDependenciesFile(JSON.stringify({ dependencies: [{ ecosystem: "cargo", name: "serde" }] }))).toHaveLength(1);
  });
});

describe("plan.db manifest round-trip (#1191 — bsc-plan deps set/get)", () => {
  // The poll reads `plan_get_deps` (a JSON object), `JSON.stringify`s it into the DEPENDENCIES
  // section, and every reader re-parses it with parseDependencyManifest. Prove that path is lossless
  // for the full manifest shape — so deps stored via the new `bsc-plan deps set` verb survive the trip
  // through plan.db exactly as the legacy `dependencies.json` did.
  it("re-parses a stored plan.db blob identically (deps + registries preserved)", () => {
    const stored = {
      registries: { internal: { url: "https://npm.internal/", scope: "@acme", auth: "INTERNAL_NPM_TOKEN" } },
      dependencies: [
        { repo: "owner/app", ecosystem: "npm", name: "zod", version: "^3.23", why: "schema validation" },
        { repo: "owner/app", ecosystem: "npm", name: "@acme/ui", version: "^2", source: "internal", why: "design system", dev: false },
        { repo: "owner/api", ecosystem: "cargo", name: "serde", version: "1", why: "(de)serialization" },
      ],
    };
    // What the poll does: stringify the DB object, then parse it like any reader.
    const m = parseDependencyManifest(JSON.stringify(stored));
    expect(m.dependencies).toHaveLength(3);
    expect(m.dependencies[1]).toMatchObject({ name: "@acme/ui", source: "internal", ecosystem: "npm" });
    expect(m.registries.internal).toEqual({ url: "https://npm.internal/", scope: "@acme", auth: "INTERNAL_NPM_TOKEN" });
    // Idempotent: re-stringifying the parsed manifest and parsing again is a fixed point.
    const again = parseDependencyManifest(JSON.stringify(m));
    expect(again).toEqual(m);
  });

  it("treats an empty / unset DB blob as an empty manifest (no deps locked yet)", () => {
    expect(parseDependencyManifest(JSON.stringify({ dependencies: [], registries: {} })))
      .toEqual({ dependencies: [], registries: {} });
    // A null `plan_get_deps` reaches the parser as "" — also empty, never a throw.
    expect(parseDependencyManifest("")).toEqual({ dependencies: [], registries: {} });
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

  it("writes the registry table form for a dep with a private source (#1127)", () => {
    const out = mergeIntoCargoToml(null, "api", [
      { ecosystem: "cargo", name: "acme-core", version: "0.3", source: "internal" },
      { ecosystem: "cargo", name: "serde", version: "1" },
    ])!;
    expect(out).toContain(`acme-core = { version = "0.3", registry = "internal" }`);
    expect(out).toContain(`serde = "1"`);
  });
});

describe("registry config writers (#1127)", () => {
  const registries: Record<string, DependencyRegistry> = {
    internal: { url: "https://npm.internal/", scope: "@acme", auth: "INTERNAL_NPM_TOKEN" },
    crates: { url: "https://crates.internal/index/" },
  };

  it("buildNpmrc emits a scoped registry + an auth-token line keyed by host", () => {
    const npmrc = buildNpmrc(registries, [{ ecosystem: "npm", name: "@acme/ui", source: "internal" }])!;
    expect(npmrc).toContain("@acme:registry=https://npm.internal/");
    expect(npmrc).toContain("//npm.internal/:_authToken=${INTERNAL_NPM_TOKEN}");
  });

  it("buildNpmrc uses a default registry line when the registry has no scope", () => {
    const noScope: Record<string, DependencyRegistry> = { mirror: { url: "https://npm.mirror/" } };
    const npmrc = buildNpmrc(noScope, [{ ecosystem: "npm", name: "left-pad", source: "mirror" }])!;
    expect(npmrc).toContain("registry=https://npm.mirror/");
    expect(npmrc).not.toContain("_authToken");
  });

  it("buildNpmrc is null when no npm dep uses a private source", () => {
    expect(buildNpmrc(registries, [{ ecosystem: "npm", name: "zod" }])).toBeNull();
    expect(buildNpmrc(registries, [{ ecosystem: "cargo", name: "serde", source: "crates" }])).toBeNull();
  });

  it("buildCargoConfig emits a [registries.<name>] table with the index url", () => {
    const cfg = buildCargoConfig(registries, [{ ecosystem: "cargo", name: "acme-core", source: "crates" }])!;
    expect(cfg).toContain("[registries.crates]");
    expect(cfg).toContain(`index = "https://crates.internal/index/"`);
  });

  it("config writers only emit registries actually used and defined", () => {
    // 'ghost' isn't in the registries map ⇒ ignored.
    expect(buildNpmrc(registries, [{ ecosystem: "npm", name: "x", source: "ghost" }])).toBeNull();
    expect(buildCargoConfig(registries, [{ ecosystem: "cargo", name: "y" }])).toBeNull();
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

  it("notes a dependency's registry source and the already-wired config (#1127)", () => {
    const md = buildWorkerDependencyBlock([
      { ecosystem: "npm", name: "@acme/ui", version: "^2", source: "internal" },
    ]);
    expect(md).toContain("from `internal` registry");
    expect(md).toMatch(/already wired in `\.npmrc`/);
  });

  it("omits the source note when every dep is from the public default", () => {
    const md = buildWorkerDependencyBlock([{ ecosystem: "npm", name: "zod" }]);
    expect(md).not.toContain("registry");
  });
});
