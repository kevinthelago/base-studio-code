import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { buildSkillLibrary, resolveBlueprintSkills } from "./blueprintSkills";
import { addSkill, removeSkill, mkStageSection } from "./blueprintEdit";
import { BlueprintEditorView } from "./BlueprintEditor";
import type { SkillDef } from "@/features/skills/lib/skills";
import type { BlueprintSection } from "../stages/blueprints";

const skillDef = (id: string, name: string): SkillDef => ({
  id, name, kind: "procedure", source: "local", desc: `${name} desc`, prompt: "", tools: [], profiles: [],
  projects: [], enabled: true, pinned: false, invocations: 0, success: 0, avgTokensK: 0, lastUsed: "", trend: [],
} as unknown as SkillDef);

describe("blueprintSkills library + resolver (#636)", () => {
  const lib = buildSkillLibrary([skillDef("s1", "API design"), skillDef("s2", "House style")]);

  it("lists skills as pickable items", () => {
    expect(lib).toEqual([
      { id: "s1", name: "API design", kind: "skill", desc: "API design desc" },
      { id: "s2", name: "House style", kind: "skill", desc: "House style desc" },
    ]);
  });

  it("resolves attached ids into found + missing", () => {
    const r = resolveBlueprintSkills(["s1", "ghost", "s2"], lib);
    expect(r.found.map((i) => i.id)).toEqual(["s1", "s2"]);
    expect(r.missing).toEqual(["ghost"]);
  });
});

describe("blueprintEdit skill helpers (#636)", () => {
  const base = (): BlueprintSection[] => [mkStageSection("api")];
  it("addSkill attaches (no dupes); removeSkill detaches", () => {
    let s = base();
    s = addSkill(s, s[0].uid, "s1");
    s = addSkill(s, s[0].uid, "s1"); // dupe ignored
    expect(s[0].skills).toEqual(["s1"]);
    s = addSkill(s, s[0].uid, "k1");
    expect(s[0].skills).toEqual(["s1", "k1"]);
    s = removeSkill(s, s[0].uid, "s1");
    expect(s[0].skills).toEqual(["k1"]);
  });
});

describe("editor Skills block (#636)", () => {
  const lib = buildSkillLibrary([skillDef("s1", "API design"), skillDef("s2", "House style")]);

  it("offers library items and attaches one on click", () => {
    const onChange = vi.fn();
    const sections = [mkStageSection("api")];
    render(<BlueprintEditorView sections={sections} selectedUid={sections[0].uid} onSelect={() => {}} onChange={onChange} skillLibrary={lib} />);
    expect(screen.getByText("Skills & knowledge")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /\+ API design/i }));
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[onChange.mock.calls.length - 1][0][0].skills).toEqual(["s1"]);
  });

  it("shows attached chips + a warning for a missing id", () => {
    const sections = [{ ...mkStageSection("api"), skills: ["s1", "ghost"] }];
    render(<BlueprintEditorView sections={sections} selectedUid={sections[0].uid} onSelect={() => {}} onChange={() => {}} skillLibrary={lib} />);
    expect(screen.getByText("API design")).toBeInTheDocument(); // attached chip
    expect(screen.getByText(/ghost/)).toBeInTheDocument(); // missing warning
  });
});
