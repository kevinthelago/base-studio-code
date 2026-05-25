import { describe, it, expect } from "vitest";
import { buildGhStructure, parsePhases, type Section } from "../screens/projects/ghStructure";

// Minimal section factory — only `k` and `content` matter to the structure.
const sec = (k: Section["k"], content = ""): Section => ({
  k, content, title: k, state: content ? "drafted" : "pending",
});

const PHASES_JSON = JSON.stringify([
  { name: "Phase 1 — Foundation", description: "scaffolding" },
  { name: "Phase 2 — Core",       description: "features" },
]);

describe("parsePhases", () => {
  it("parses a JSON array of phases", () => {
    const phases = parsePhases(PHASES_JSON);
    expect(phases).toHaveLength(2);
    expect(phases[0].name).toBe("Phase 1 — Foundation");
  });

  it("returns [] for empty content", () => {
    expect(parsePhases("")).toEqual([]);
  });

  it("returns [] for non-JSON content", () => {
    expect(parsePhases("just some prose, not json")).toEqual([]);
  });

  it("returns [] when JSON is not an array (e.g. an object)", () => {
    expect(parsePhases('{"name":"x"}')).toEqual([]);
  });
});

describe("buildGhStructure", () => {
  it("creates one repo node per linked repository, id-prefixed", () => {
    const s = buildGhStructure([sec("goal", "A tool.")], ["acme/api", "acme/web"], "My Project");
    expect(s.repos.map(r => r.node)).toEqual([
      { id: "repo:acme/api", label: "acme/api" },
      { id: "repo:acme/web", label: "acme/web" },
    ]);
  });

  it("creates a single project node labelled with the title", () => {
    const s = buildGhStructure([], [], "My Project");
    expect(s.project).toEqual({ id: "project", label: "My Project" });
  });

  it("derives one milestone node per phase", () => {
    const s = buildGhStructure([sec("phases", PHASES_JSON)], [], "P");
    expect(s.milestones).toEqual([
      { id: "ms:0", label: "Phase 1 — Foundation" },
      { id: "ms:1", label: "Phase 2 — Core" },
    ]);
  });

  it("nests one tracking-issue node per phase under each repo", () => {
    const s = buildGhStructure([sec("phases", PHASES_JSON)], ["acme/api", "acme/web"], "My Project");
    expect(s.repos[0].issues).toEqual([
      { id: "issue:acme/api:0", label: "[Phase 1 — Foundation] My Project" },
      { id: "issue:acme/api:1", label: "[Phase 2 — Core] My Project" },
    ]);
    expect(s.repos[1].issues).toEqual([
      { id: "issue:acme/web:0", label: "[Phase 1 — Foundation] My Project" },
      { id: "issue:acme/web:1", label: "[Phase 2 — Core] My Project" },
    ]);
  });

  it("namespaces issue ids by repo so the same phase is distinct per repo", () => {
    const s = buildGhStructure([sec("phases", PHASES_JSON)], ["acme/api", "acme/web"], "P");
    const allIds = s.repos.flatMap(r => r.issues.map(i => i.id));
    expect(new Set(allIds).size).toBe(allIds.length); // all unique
    expect(allIds).toContain("issue:acme/api:0");
    expect(allIds).toContain("issue:acme/web:0");
  });

  it("gives a repo no issues when the phases section is absent", () => {
    const s = buildGhStructure([sec("goal", "A tool.")], ["acme/api"], "P");
    expect(s.milestones).toEqual([]);
    expect(s.repos[0].issues).toEqual([]);
  });

  it("yields no milestones and no repo issues when phases content is invalid JSON", () => {
    const s = buildGhStructure([sec("phases", "not json")], ["acme/api"], "P");
    expect(s.milestones).toEqual([]);
    expect(s.repos[0].issues).toEqual([]);
  });

  it("milestone ids and per-repo issue ids share the phase index so status maps line up", () => {
    const s = buildGhStructure([sec("phases", PHASES_JSON)], ["acme/api"], "P");
    expect(s.milestones.map(m => m.id)).toEqual(["ms:0", "ms:1"]);
    expect(s.repos[0].issues.map(i => i.id)).toEqual(["issue:acme/api:0", "issue:acme/api:1"]);
  });

  it("has no repos when none are linked", () => {
    const s = buildGhStructure([sec("phases", PHASES_JSON)], [], "P");
    expect(s.repos).toEqual([]);
  });
});
