import { describe, it, expect } from "vitest";
import { hubToCanonical, applyPush, isPlanFile } from "../lib/plannerSync/bridge";
import type { HubSnapshot } from "../lib/plannerSync/bridge";
import { buildManifest, fnv1a32hex } from "../lib/plannerCore/index";
import fixtures from "../lib/plannerCore.fixtures.json";

// ── isPlanFile ────────────────────────────────────────────────────────────────

describe("isPlanFile", () => {
  it("accepts root .md files", () => {
    expect(isPlanFile("goal.md")).toBe(true);
    expect(isPlanFile("_skipped.md")).toBe(true);
    expect(isPlanFile("custom-topic.md")).toBe(true);
  });

  it("accepts the known JSON plan files", () => {
    for (const f of ["phases.json", "issues.json", "fleet.json", "repos.json", "plan.json"]) {
      expect(isPlanFile(f)).toBe(true);
    }
  });

  it("rejects files in subdirectories", () => {
    expect(isPlanFile("prompts/kickoff.md")).toBe(false);
    expect(isPlanFile("base-studio-code/CLAUDE.md")).toBe(false);
  });

  it("rejects unknown root files", () => {
    expect(isPlanFile("commands.json")).toBe(false);
    expect(isPlanFile("README.md")).toBe(true);  // .md files are included regardless of name
    expect(isPlanFile("config.json")).toBe(false);
  });
});

// ── hubToCanonical ────────────────────────────────────────────────────────────

const minimalSnap = (): HubSnapshot => ({
  projectTitle: "foobar",
  sections: { goal: "foobar" },
  confirmedSections: [],
});

describe("hubToCanonical", () => {
  it("produces a stable projectId from the title", () => {
    const { meta } = hubToCanonical(minimalSnap());
    expect(meta.projectId).toBe(fixtures.projectId.id);  // "proj-bf9cf968"
  });

  it("uses existingProjectId when provided (no re-derivation)", () => {
    const snap = { ...minimalSnap(), existingProjectId: "proj-custom" };
    expect(hubToCanonical(snap).meta.projectId).toBe("proj-custom");
  });

  it("each section becomes a {key}.md file", () => {
    const snap: HubSnapshot = {
      projectTitle: "p",
      sections: { goal: "goal content", scope: "scope content" },
      confirmedSections: [],
    };
    const { files } = hubToCanonical(snap);
    const relpaths = files.map((f) => f.relpath);
    expect(relpaths).toContain("goal.md");
    expect(relpaths).toContain("scope.md");
  });

  it("confirmed sections get state 'confirmed'", () => {
    const snap: HubSnapshot = {
      projectTitle: "p",
      sections: { goal: "g", scope: "s" },
      confirmedSections: ["goal"],
    };
    const { meta } = hubToCanonical(snap);
    expect(meta.sectionStates["goal"]).toBe("confirmed");
    expect(meta.sectionStates["scope"]).toBe("drafted");
  });

  it("unconfirmed sections with content get state 'drafted'", () => {
    const snap: HubSnapshot = {
      projectTitle: "p",
      sections: { stack: "typescript" },
      confirmedSections: [],
    };
    expect(hubToCanonical(snap).meta.sectionStates["stack"]).toBe("drafted");
  });

  it("empty sections are excluded from the file list", () => {
    const snap: HubSnapshot = {
      projectTitle: "p",
      sections: { goal: "content", empty: "" },
      confirmedSections: [],
    };
    const relpaths = hubToCanonical(snap).files.map((f) => f.relpath);
    expect(relpaths).not.toContain("empty.md");
  });

  it("skipped sections are included from _skipped.md and marked 'skipped'", () => {
    const snap: HubSnapshot = {
      projectTitle: "p",
      sections: {},
      confirmedSections: [],
      skippedContent: "- **analytics** — out of scope for v1\n- ux: covered elsewhere",
    };
    const { files, meta } = hubToCanonical(snap);
    expect(files.some((f) => f.relpath === "_skipped.md")).toBe(true);
    expect(meta.sectionStates["analytics"]).toBe("skipped");
    expect(meta.sectionStates["ux"]).toBe("skipped");
  });

  it("includes JSON plan files when provided", () => {
    const snap: HubSnapshot = {
      projectTitle: "p",
      sections: {},
      confirmedSections: [],
      phasesJson: '[{"name":"P1"}]',
      issuesJson: '[{"ref":"F1","title":"thing","acceptance":[],"owns":[],"dependsOn":[],"labels":[]}]',
      fleetJson:  '{"recommended":1,"reasoning":"","streams":[],"director":{"enabled":false}}',
      reposJson:  '["owner/repo"]',
    };
    const relpaths = hubToCanonical(snap).files.map((f) => f.relpath);
    expect(relpaths).toContain("phases.json");
    expect(relpaths).toContain("issues.json");
    expect(relpaths).toContain("fleet.json");
    expect(relpaths).toContain("repos.json");
  });

  it("always includes plan.json with the stable projectId", () => {
    const { files, meta } = hubToCanonical(minimalSnap());
    const planFile = files.find((f) => f.relpath === "plan.json");
    expect(planFile).toBeDefined();
    const parsed = JSON.parse(planFile!.content);
    expect(parsed.projectId).toBe(meta.projectId);
    expect(parsed.title).toBe("foobar");
  });

  it("files are sorted by relpath", () => {
    const snap: HubSnapshot = {
      projectTitle: "p",
      sections: { stack: "s", goal: "g", architecture: "a" },
      confirmedSections: [],
    };
    const relpaths = hubToCanonical(snap).files.map((f) => f.relpath);
    const sorted = [...relpaths].sort();
    expect(relpaths).toEqual(sorted);
  });

  it("content hash in manifest matches fnv1a32hex of content", () => {
    const snap = minimalSnap();
    const { files } = hubToCanonical(snap);
    const manifest = buildManifest(fixtures.projectId.id, files);
    for (const file of files) {
      expect(manifest.files[file.relpath]).toBe(fnv1a32hex(file.content));
    }
  });

  it("produces the pinned fixture manifest for goal.md='foobar', phases.json='a'", () => {
    const snap: HubSnapshot = {
      projectTitle: "foobar",
      existingProjectId: fixtures.manifest.projectId,
      sections: { goal: "foobar" },
      confirmedSections: [],
      phasesJson: "a",
    };
    const { files } = hubToCanonical(snap);
    const manifest = buildManifest(fixtures.manifest.projectId, files);
    expect(manifest.files["goal.md"]).toBe(fixtures.manifest.files["goal.md"]);
    expect(manifest.files["phases.json"]).toBe(fixtures.manifest.files["phases.json"]);
  });
});

// ── applyPush ────────────────────────────────────────────────────────────────

describe("applyPush", () => {
  it("overwrites a section file", () => {
    const snap = { ...minimalSnap(), sections: { goal: "old" } };
    const result = applyPush(snap, [{ relpath: "goal.md", content: "new" }]);
    expect(result.sections["goal"]).toBe("new");
  });

  it("adds a new section from a pushed .md file", () => {
    const result = applyPush(minimalSnap(), [{ relpath: "scope.md", content: "scope text" }]);
    expect(result.sections["scope"]).toBe("scope text");
  });

  it("updates JSON plan files", () => {
    const pushed = [
      { relpath: "phases.json",  content: '[{"name":"P1"}]' },
      { relpath: "issues.json",  content: '[]' },
      { relpath: "fleet.json",   content: '{}' },
      { relpath: "repos.json",   content: '["o/r"]' },
    ];
    const result = applyPush(minimalSnap(), pushed);
    expect(result.phasesJson).toBe('[{"name":"P1"}]');
    expect(result.issuesJson).toBe('[]');
    expect(result.fleetJson).toBe('{}');
    expect(result.reposJson).toBe('["o/r"]');
  });

  it("extracts projectId from plan.json", () => {
    const planJson = JSON.stringify({ projectId: "proj-abc123", title: "t", sectionStates: {} });
    const result = applyPush(minimalSnap(), [{ relpath: "plan.json", content: planJson }]);
    expect(result.existingProjectId).toBe("proj-abc123");
  });

  it("does not mutate the original snapshot", () => {
    const snap = { ...minimalSnap(), sections: { goal: "original" } };
    applyPush(snap, [{ relpath: "goal.md", content: "changed" }]);
    expect(snap.sections["goal"]).toBe("original");
  });

  it("ignores subdirectory files", () => {
    const result = applyPush(minimalSnap(), [{ relpath: "prompts/kickoff.md", content: "x" }]);
    expect(result.sections["prompts/kickoff"]).toBeUndefined();
  });

  it("round-trip: hubToCanonical → applyPush reproduces the same sections", () => {
    const original: HubSnapshot = {
      projectTitle: "foobar",
      sections: { goal: "the goal text", stack: "typescript" },
      confirmedSections: ["goal"],
      phasesJson: '[{"name":"Phase 1"}]',
    };
    const { files } = hubToCanonical(original);
    const restored = applyPush({ ...minimalSnap(), projectTitle: original.projectTitle }, files);
    expect(restored.sections["goal"]).toBe("the goal text");
    expect(restored.sections["stack"]).toBe("typescript");
    expect(restored.phasesJson).toBe('[{"name":"Phase 1"}]');
  });
});
