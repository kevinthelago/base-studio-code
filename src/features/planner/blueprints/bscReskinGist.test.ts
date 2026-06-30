import { describe, it, expect } from "vitest";
import { validateManifest } from "@/features/planner/lib/gist/manifest";
import { manifestToBlueprint, bundledSkillsFromManifest } from "./blueprintShare";
// The "base-studio-code Reskin" blueprint (#1212) ships as a GitHub gist, not a packaged built-in.
// Its canonical source lives at docs/blueprints/bsc-reskin/extension.json and is published verbatim.
// This guards the acceptance criterion "the blueprint JSON validates / imports cleanly" so the gist
// can't silently rot: it must pass the SAME envelope validation + blueprint coercion the in-app
// import-from-gist path runs.
import manifest from "../../../../docs/blueprints/bsc-reskin/extension.json";

describe("bsc-reskin gist blueprint (#1212)", () => {
  it("is valid JSON wrapping a blueprint manifest", () => {
    const res = validateManifest(manifest);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.kind).toBe("blueprint");
    expect(res.manifest.id).toBe("bsc-reskin");
  });

  it("coerces to a transform/operate blueprint with the reskin stages", () => {
    const res = validateManifest(manifest);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const bp = manifestToBlueprint(res.manifest);
    expect(bp.ok).toBe(true);
    if (!bp.ok) return;
    expect(bp.blueprint.category).toBe("transform");
    expect(bp.blueprint.mode).toBe("operate");
    // Every stage resolved with a key, name, and a working prompt.
    expect(bp.blueprint.sections.length).toBeGreaterThanOrEqual(9);
    expect(bp.blueprint.sections.every((s) => s.key && s.name && s.prompt)).toBe(true);
    // The theme-token + deployment stages are present, and the reskin skill is attached.
    const keys = bp.blueprint.sections.map((s) => s.key);
    expect(keys).toContain("deployment");
    expect(keys).toContain("theme-tokens");
    expect(bp.blueprint.skills).toContain("reskin-bsc");
  });

  it("bundles the reskin skill with the token system + the design/ guardrail", () => {
    const res = validateManifest(manifest);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const skills = bundledSkillsFromManifest(res.manifest);
    expect(skills).toHaveLength(1);
    const skill = skills[0];
    expect(skill.id).toBe("reskin-bsc");
    // The content carries the essentials: oklch, the light/dark mechanism, and the design/ rule.
    expect(skill.content).toMatch(/oklch/i);
    expect(skill.content).toMatch(/data-theme/);
    expect(skill.content).toMatch(/design\/.*REFERENCE-ONLY|REFERENCE-ONLY.*design\//s);
    expect(skill.content).toMatch(/tokens\.css/);
  });
});
