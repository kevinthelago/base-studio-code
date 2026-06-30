import { describe, it, expect } from "vitest";
import { buildGhStructure, type Section } from "./ghStructure";

// Minimal section factory — only `k` and `content` matter to the structure.
const sec = (k: Section["k"], content = ""): Section => ({
  k, content, title: k, state: content ? "drafted" : "pending",
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

  it("gives a repo no issues when no features section is present", () => {
    const s = buildGhStructure([sec("goal", "A tool.")], ["acme/api"], "P");
    expect(s.repos[0].issues).toEqual([]);
  });

  it("yields no repo issues when the features content is invalid JSON", () => {
    const s = buildGhStructure([sec("features", "not json")], ["acme/api"], "P");
    expect(s.repos[0].issues).toEqual([]);
  });

  it("has no repos when none are linked", () => {
    const s = buildGhStructure([sec("goal", "A tool.")], [], "P");
    expect(s.repos).toEqual([]);
  });
});

describe("buildGhStructure — issues generated from features (#plan-db)", () => {
  it("nests one node per FEATURE under the repo (slug = id, name = label)", () => {
    const features = JSON.stringify([
      { slug: "endpoint", name: "Add endpoint" },
      { slug: "ui", name: "Wire UI", dependsOn: ["endpoint"] },
    ]);
    const st = buildGhStructure([sec("features", features)], ["o/web"], "Proj");
    expect(st.repos[0].issues.map(i => i.label)).toEqual(["Add endpoint", "Wire UI"]);
    expect(st.repos[0].issues.map(i => i.id)).toEqual(["issue:o/web:endpoint", "issue:o/web:ui"]);
  });

  it("routes every feature-issue to the default (first) repo — features carry no repo", () => {
    const features = JSON.stringify([
      { slug: "a", name: "first" },
      { slug: "b", name: "second" },
    ]);
    const st = buildGhStructure([sec("features", features)], ["o/web", "o/api"], "Proj");
    expect(st.repos.find(r => r.node.label === "o/web")!.issues.map(i => i.label)).toEqual(["first", "second"]);
    expect(st.repos.find(r => r.node.label === "o/api")!.issues).toEqual([]);
  });

  it("namespaces issue ids by repo so the same slug is distinct per repo", () => {
    const features = JSON.stringify([{ slug: "a", name: "first" }]);
    const st = buildGhStructure([sec("features", features)], ["o/web"], "Proj");
    expect(st.repos[0].issues.map(i => i.id)).toEqual(["issue:o/web:a"]);
  });
});
