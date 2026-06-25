import { describe, it, expect } from "vitest";
import {
  commonsGlobsForStack,
  stackTagsFromSection,
  excludeCommonsFromOwns,
  UNION_MERGE_COMMONS,
} from "./commons";
import { matchGlob } from "./sessionRoles";

describe("commonsGlobsForStack (#851 — stack-derived commons set)", () => {
  it("always includes the universal base commons (ignore, gitattributes, CI, env, formatter)", () => {
    const c = commonsGlobsForStack([]);
    for (const g of [".gitignore", ".gitattributes", ".github/workflows/**", ".env.example", ".editorconfig"]) {
      expect(c).toContain(g);
    }
  });

  it("adds the JS/TS manifest + lockfiles + tsconfig for a react/node/typescript stack", () => {
    for (const tag of ["react", "node", "typescript", "vite", "next"]) {
      const c = commonsGlobsForStack([tag]);
      expect(c).toContain("package.json");
      expect(c).toContain("package-lock.json");
      expect(c).toContain("pnpm-lock.yaml");
      expect(c).toContain("yarn.lock");
      expect(c).toContain("tsconfig.json");
      expect(c).toContain("tsconfig.*.json");
    }
  });

  it("adds the Cargo manifest + lockfile for a rust stack", () => {
    const c = commonsGlobsForStack(["rust"]);
    expect(c).toContain("Cargo.toml");
    expect(c).toContain("Cargo.lock");
  });

  it("a tauri stack pulls in BOTH the JS/TS and the Rust commons", () => {
    const c = commonsGlobsForStack(["tauri"]);
    expect(c).toContain("package.json");
    expect(c).toContain("Cargo.toml");
  });

  it("adds python/go manifests for those stacks", () => {
    expect(commonsGlobsForStack(["python"])).toContain("pyproject.toml");
    expect(commonsGlobsForStack(["go"])).toContain("go.mod");
    expect(commonsGlobsForStack(["go"])).toContain("go.sum");
  });

  it("is case-insensitive and substring-matched (React, TypeScript, golang)", () => {
    expect(commonsGlobsForStack(["React"])).toContain("package.json");
    expect(commonsGlobsForStack(["TypeScript"])).toContain("tsconfig.json");
    expect(commonsGlobsForStack(["golang"])).toContain("go.mod");
  });

  it("dedupes when multiple tags map to the same glob (no repeated package.json)", () => {
    const c = commonsGlobsForStack(["react", "node", "vite"]);
    expect(c.filter((g) => g === "package.json")).toHaveLength(1);
  });

  it("an unrecognized stack still yields the base commons (never empty)", () => {
    const c = commonsGlobsForStack(["cobol", "fortran"]);
    expect(c).toContain(".gitignore");
    expect(c).not.toContain("package.json");
    expect(c).not.toContain("Cargo.toml");
  });
});

describe("stackTagsFromSection (free-text stack.md → tags)", () => {
  it("tokenizes prose into lowercase tags the derivation can match", () => {
    const tags = stackTagsFromSection("React 18 + TypeScript frontend, Rust (Tauri) backend, Vite bundler.");
    expect(commonsGlobsForStack(tags)).toContain("package.json");
    expect(commonsGlobsForStack(tags)).toContain("Cargo.toml");
    expect(commonsGlobsForStack(tags)).toContain("tsconfig.json");
  });

  it("empty section ⇒ no tags ⇒ base commons only", () => {
    expect(stackTagsFromSection("")).toEqual([]);
    expect(commonsGlobsForStack(stackTagsFromSection(""))).not.toContain("package.json");
  });
});

describe("excludeCommonsFromOwns (the owns-exclusion)", () => {
  const commons = commonsGlobsForStack(["tauri"]); // js/ts + rust commons

  it("strips an exact commons glob a stream declared", () => {
    expect(excludeCommonsFromOwns([".gitignore", "src/auth/**"], commons, matchGlob)).toEqual(["src/auth/**"]);
  });

  it("strips a concrete path that falls inside a commons glob (.github/workflows/ci.yml)", () => {
    const owns = [".github/workflows/ci.yml", "src/api/**"];
    expect(excludeCommonsFromOwns(owns, commons, matchGlob)).toEqual(["src/api/**"]);
  });

  it("leaves a pure feature boundary untouched", () => {
    const owns = ["src/auth/**", "src/components/login/**"];
    expect(excludeCommonsFromOwns(owns, commons, matchGlob)).toEqual(owns);
  });

  it("removes package.json / Cargo.toml / tsconfig if a stream tries to own them", () => {
    const owns = ["package.json", "Cargo.toml", "tsconfig.json", "src/x/**"];
    expect(excludeCommonsFromOwns(owns, commons, matchGlob)).toEqual(["src/x/**"]);
  });
});

describe("UNION_MERGE_COMMONS", () => {
  it("is the additive subset only (.gitignore, .env.example) — not the structured manifests", () => {
    expect(UNION_MERGE_COMMONS).toContain(".gitignore");
    expect(UNION_MERGE_COMMONS).toContain(".env.example");
    expect(UNION_MERGE_COMMONS).not.toContain("package.json");
    expect(UNION_MERGE_COMMONS).not.toContain("tsconfig.json");
  });
});
