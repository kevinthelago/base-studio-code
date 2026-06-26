// Pure stage-edit helpers for the new Blueprints editor (#609). Operate on a
// BlueprintSection[] and return a new array — the editor calls these then persists via
// setBlueprintSections. Superset model (#609 option A): the runtime fields (gateRule /
// appliesWhen / enabled) are preserved untouched; these add the editor's stage ops
// (add by kind, reorder, dep toggle, pipeline trigger/gate, output disposition).

import {
  type BlueprintSection,
  SECTION_DEFS, mkSection, uid,
} from "../stages/blueprints";
import { stageKind, defaultDisposition } from "./blueprintCatalog";

/** Build a section for ANY stage kind. Known kinds (in SECTION_DEFS) keep their runtime
 *  gate; unknown ones (users/stack/…) are synthesized as informational stages. */
export function mkStageSection(kind: string): BlueprintSection {
  if (SECTION_DEFS[kind]) {
    const s = mkSection(kind);
    return { ...s, output: s.output ?? defaultDisposition(kind) };
  }
  const k = stageKind(kind);
  return {
    uid: uid("sec"), key: kind, name: k.title, glyph: "✚", icon: k.glyph, hue: k.h,
    gate: "stage complete", deps: [], blurb: k.blurb,
    prompt: `Document the project's ${k.title.toLowerCase()}. ${k.blurb}`,
    enabled: true, expanded: false, output: defaultDisposition(kind),
  };
}

const mapSec = (sections: BlueprintSection[], u: string, fn: (s: BlueprintSection) => BlueprintSection) =>
  sections.map((s) => (s.uid === u ? fn(s) : s));

/** Move a stage from index `from` to index `to`. */
export function reorderStages(sections: BlueprintSection[], from: number, to: number): BlueprintSection[] {
  if (from === to || from < 0 || from >= sections.length || to < 0 || to >= sections.length) return sections;
  const a = [...sections];
  const [m] = a.splice(from, 1);
  a.splice(to, 0, m);
  return a;
}

/** Append a fresh stage of `kind`. */
export function addStage(sections: BlueprintSection[], kind: string): BlueprintSection[] {
  return [...sections, mkStageSection(kind)];
}

/** Delete a stage and scrub it from other stages' deps (deps are section keys). */
export function deleteStage(sections: BlueprintSection[], u: string): BlueprintSection[] {
  const victim = sections.find((s) => s.uid === u);
  const out = sections.filter((s) => s.uid !== u);
  if (!victim) return out;
  // Only scrub the victim's key if no other remaining section shares it.
  if (out.some((s) => s.key === victim.key)) return out;
  return out.map((s) => ({ ...s, deps: s.deps.filter((d) => d !== victim.key) }));
}

/** Toggle a dependency (by the depended-on stage's key) on a stage. */
export function toggleDep(sections: BlueprintSection[], secUid: string, depKey: string): BlueprintSection[] {
  return mapSec(sections, secUid, (s) => ({
    ...s,
    deps: s.deps.includes(depKey) ? s.deps.filter((d) => d !== depKey) : [...s.deps, depKey],
  }));
}

export function setOutput(sections: BlueprintSection[], secUid: string, output: string): BlueprintSection[] {
  return mapSec(sections, secUid, (s) => ({ ...s, output }));
}

/** Attach a skill/knowledge id to a section (no-op if already attached). (#636) */
export function addSkill(sections: BlueprintSection[], secUid: string, skillId: string): BlueprintSection[] {
  return mapSec(sections, secUid, (s) => ((s.skills ?? []).includes(skillId) ? s : { ...s, skills: [...(s.skills ?? []), skillId] }));
}
/** Detach a skill/knowledge id from a section. (#636) */
export function removeSkill(sections: BlueprintSection[], secUid: string, skillId: string): BlueprintSection[] {
  return mapSec(sections, secUid, (s) => ({ ...s, skills: (s.skills ?? []).filter((x) => x !== skillId) }));
}

/** Attach an MCP server (by name) to a section (no-op if already attached). (#897) */
export function addMcpServer(sections: BlueprintSection[], secUid: string, name: string): BlueprintSection[] {
  return mapSec(sections, secUid, (s) => ((s.mcp ?? []).includes(name) ? s : { ...s, mcp: [...(s.mcp ?? []), name] }));
}
/** Detach an MCP server (by name) from a section. (#897) */
export function removeMcpServer(sections: BlueprintSection[], secUid: string, name: string): BlueprintSection[] {
  return mapSec(sections, secUid, (s) => ({ ...s, mcp: (s.mcp ?? []).filter((x) => x !== name) }));
}
export function setStageField(
  sections: BlueprintSection[], secUid: string, patch: Partial<Pick<BlueprintSection, "name" | "prompt">>,
): BlueprintSection[] {
  return mapSec(sections, secUid, (s) => ({ ...s, ...patch }));
}

/** Stages that may precede `secUid` as dependency candidates (only earlier stages,
 *  preventing cycles) — what the dependency editor offers. */
export function depCandidates(sections: BlueprintSection[], secUid: string): BlueprintSection[] {
  const i = sections.findIndex((s) => s.uid === secUid);
  return i <= 0 ? [] : sections.slice(0, i);
}
