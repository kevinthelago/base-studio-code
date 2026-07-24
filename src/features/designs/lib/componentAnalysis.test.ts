import { describe, it, expect } from "vitest";
import { deriveComposes, deriveRole, renderedComponentCount, analyzeComponent, buildNameResolver } from "./componentAnalysis";

const RECORDS = [
  { id: "githubpage", name: "GitHubWorkspace", provides: undefined, kitId: "base-studio-code" },
  { id: "github-summary", name: "GitHubSummary", provides: undefined, kitId: "base-studio-code" },
  { id: "github-repos-grid", name: "GitHubReposGrid", provides: undefined, kitId: "base-studio-code" },
  { id: "ui-chip", name: "Chip", provides: "@/shared/ui/data/Chip", kitId: "base-studio-code" },
  { id: "other-kit", name: "Other", provides: "@/shared/ui/data/Chip", kitId: "react-ui" }, // wrong kit → ignored
];
const resolve = buildNameResolver(RECORDS, "base-studio-code");

describe("deriveComposes (#3667) — edges are NAMES of graph nodes only", () => {
  it("resolves @/components/<id> siblings + provided @/shared/ui specifiers; ignores plain code + cross-kit", () => {
    const src = `
      import { GitHubSummary } from "@/components/github-summary";
      import { GitHubReposGrid } from "@/components/github-repos-grid";
      import { Chip } from "@/shared/ui/data/Chip";          // provided → a graph edge
      import { Button } from "@/shared/ui/controls/Button";  // plain code (not provided) → NOT an edge
      import { useAppStore } from "@/store";                 // not a component
    `;
    expect(deriveComposes(src, resolve)).toEqual(["Chip", "GitHubReposGrid", "GitHubSummary"]); // sorted names
  });

  it("returns [] for a leaf primitive with no graph imports", () => {
    expect(deriveComposes(`import type { CSSProperties } from "react"; export function C(){return null;}`, resolve)).toEqual([]);
  });
});

describe("deriveRole (#3667) — the swimlane tier", () => {
  it("a page stays a page; a structural container is layout; assemblers are composite; atoms are primitive", () => {
    expect(deriveRole("GitHubWorkspace", "page", ["GitHubSummary"], 5)).toBe("page");
    expect(deriveRole("Box", "component", [], 0)).toBe("layout");
    expect(deriveRole("GitHubSummary", "component", ["GitHubReposGrid"], 8)).toBe("composite"); // composes a sibling
    expect(deriveRole("SettingsGeneralPage", "component", [], 6)).toBe("composite"); // renders ≥3 (code cards)
    expect(deriveRole("Chip", "primitive", [], 1)).toBe("primitive"); // a leaf atom
    expect(deriveRole("ColorSwatch", "primitive", [], 0)).toBe("primitive");
  });
});

describe("renderedComponentCount — distinct JSX component tags", () => {
  it("counts distinct <Capitalized> tags (deduped), not intrinsics", () => {
    // Card, Row, Text = 3 distinct components; <div> is an intrinsic; the second <Card/> is deduped.
    expect(renderedComponentCount(`<div><Card/><Row><Card/><Text>x</Text></Row></div>`)).toBe(3);
  });
});

describe("analyzeComponent — composes + role together", () => {
  it("a tab body that composes a sibling → composite with the sibling name as an edge", () => {
    const meta = analyzeComponent(
      { name: "GitHubSummary", role: "component", srcText: `import { GitHubReposGrid } from "@/components/github-repos-grid"; export function GitHubSummary(){ return <GitHubReposGrid/>; }` },
      resolve,
    );
    expect(meta).toEqual({ composes: ["GitHubReposGrid"], role: "composite" });
  });
});
