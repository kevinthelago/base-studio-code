// Blueprint skills attachment (#636 slice a). A blueprint section (and the blueprint as a
// whole) can reference reusable library Skills that slice b injects into the agent's context.
// This resolves attached ids (so the editor can show what's attached + warn about anything
// missing). Pure. (The Knowledge Blocks half of this library was retired in #1460 — Skills only.)

import { type SkillDef } from "@/features/skills/lib/skills";
import { type SkillKind } from "@/shared/data/skills";
import { writeProjectFile } from "@/shared/lib/core/projectFiles";
import { type Blueprint } from "../stages/blueprints";

/** One pickable library item, from the Skills library. */
export interface BlueprintSkillItem {
  id: string;
  name: string;
  kind: "skill";
  desc?: string;
}

/** Build the Skills library list for the editor's picker. */
export function buildSkillLibrary(skills: SkillDef[]): BlueprintSkillItem[] {
  return skills.map((s): BlueprintSkillItem => ({ id: s.id, name: s.name, kind: "skill", desc: s.desc }));
}

export interface ResolvedSkills { found: BlueprintSkillItem[]; missing: string[] }

/** Resolve attached ids against the library: `found` for display, `missing` to warn
 *  (a referenced item that isn't installed — the distribution gap). Order preserved. */
export function resolveBlueprintSkills(ids: string[], library: BlueprintSkillItem[]): ResolvedSkills {
  const byId = new Map(library.map((i) => [i.id, i]));
  const found: BlueprintSkillItem[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item) found.push(item);
    else missing.push(id);
  }
  return { found, missing };
}

// ── injection (#636 slice b): resolve attached skills to content + write the context ──

export interface SkillContentItem { name: string; kind: "skill"; content: string }

/** Resolve ids to their content (a SkillDef's prompt). Missing ids are skipped (they surface
 *  as warnings in the editor). */
export function resolveSkillContent(ids: string[], skills: SkillDef[]): SkillContentItem[] {
  const skillById = new Map(skills.map((s) => [s.id, s]));
  const out: SkillContentItem[] = [];
  for (const id of ids) {
    const s = skillById.get(id);
    if (s) out.push({ name: s.name, kind: "skill", content: s.prompt });
  }
  return out;
}

// ── content embedding for share (#897 Phase 5b) ─────────────────────────────
// A shared blueprint references skills by id. To make it self-contained for KNOWLEDGE, the
// share bundles each attached item's full CONTENT (a SkillPayload), and the recipient
// reconstitutes them into their library so the id refs resolve. (MCP servers stay by reference
// — code, not content; they download from their catalog link on use.)

/** An attached skill item, with enough content to faithfully reconstitute it on import. */
export interface SkillPayload {
  /** The library id — kept so the blueprint's refs resolve after reconstitution. */
  id: string;
  name: string;
  kind: "skill";
  /** SkillDef.prompt. */
  content: string;
  desc?: string;
  tags?: string[];
  /** For a skill: its SkillDef.kind + tools, carried so reconstitution is faithful. */
  skillKind?: SkillKind;
  tools?: string[];
}

/** Every distinct skill id a blueprint attaches (project-wide + every stage), order-preserving. */
export function collectBlueprintSkillIds(bp: Blueprint): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: string) => { if (!seen.has(id)) { seen.add(id); out.push(id); } };
  for (const id of bp.skills ?? []) add(id);
  for (const s of bp.sections) for (const id of s.skills ?? []) add(id);
  return out;
}

/** Resolve a blueprint's attached skill ids to full {@link SkillPayload}s for embedding in a
 *  share. Missing ids (not in the library) are skipped. */
export function resolveBlueprintSkillPayloads(bp: Blueprint, skills: SkillDef[]): SkillPayload[] {
  const skillById = new Map(skills.map((s) => [s.id, s]));
  const out: SkillPayload[] = [];
  for (const id of collectBlueprintSkillIds(bp)) {
    const s = skillById.get(id);
    if (s) out.push({ id: s.id, name: s.name, kind: "skill", content: s.prompt, desc: s.desc, skillKind: s.kind, tools: s.tools });
  }
  return out;
}

/** Render a blueprint's attached skills (project-wide + per-stage) into a markdown doc
 *  the agents read (`skills.md`). Empty string when nothing is attached. */
export function buildSkillContext(bp: Blueprint, skills: SkillDef[]): string {
  const render = (items: SkillContentItem[]) =>
    items.map((i) => `### ${i.name} _(${i.kind})_\n\n${i.content.trim() || "_(no content)_"}`).join("\n\n");
  const blocks: string[] = [];
  const wide = resolveSkillContent(bp.skills ?? [], skills);
  if (wide.length) blocks.push(`## Project-wide\n\n${render(wide)}`);
  for (const sec of bp.sections) {
    const items = resolveSkillContent(sec.skills ?? [], skills);
    if (items.length) blocks.push(`## ${sec.name} stage\n\n${render(items)}`);
  }
  if (blocks.length === 0) return "";
  return `# Attached skills & knowledge\n\nReusable context paired with this project's blueprint — read the section relevant to the current stage.\n\n${blocks.join("\n\n")}\n`;
}

/** Resolve + write the blueprint's attached skills to the project hub's skills.md, where
 *  the planner (and downstream sessions) read them. No-op when nothing is attached. */
export async function writeBlueprintSkillContext(args: { projectKey: string; blueprint: Blueprint; skills: SkillDef[] }): Promise<void> {
  const content = buildSkillContext(args.blueprint, args.skills);
  if (!content) return;
  await writeProjectFile(args.projectKey, "skills.md", content);
}
