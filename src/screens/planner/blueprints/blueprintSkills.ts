// Blueprint skills/knowledge attachment (#636 slice a). A blueprint section (and the
// blueprint as a whole) can reference reusable library items — Knowledge Blocks or
// Skills — that slice b injects into the agent's context. This unifies the two libraries
// into one pickable list and resolves attached ids (so the editor can show what's
// attached + warn about anything missing). Pure.

import { type SkillDef } from "../../../lib/skills";
import { type SkillKind } from "../../../data/skills";
import { type KbBlock } from "../../../data/mock";
import { writeProjectFile } from "../../../lib/projectFiles";
import { type Blueprint } from "../blueprints";

/** One pickable library item, from either library. */
export interface BlueprintSkillItem {
  id: string;
  name: string;
  kind: "skill" | "kb";
  desc?: string;
}

/** Unify the Skills library + Knowledge Blocks into one list for the editor's picker. */
export function buildSkillLibrary(skills: SkillDef[], kb: KbBlock[]): BlueprintSkillItem[] {
  return [
    ...skills.map((s): BlueprintSkillItem => ({ id: s.id, name: s.name, kind: "skill", desc: s.desc })),
    ...kb.map((b): BlueprintSkillItem => ({ id: b.id, name: b.title, kind: "kb", desc: b.tags.join(", ") || undefined })),
  ];
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

export interface SkillContentItem { name: string; kind: "skill" | "kb"; content: string }

/** Resolve ids to their content (a SkillDef's prompt / a KB block's body). Missing ids
 *  are skipped (they surface as warnings in the editor). */
export function resolveSkillContent(ids: string[], skills: SkillDef[], kb: KbBlock[]): SkillContentItem[] {
  const skillById = new Map(skills.map((s) => [s.id, s]));
  const kbById = new Map(kb.map((b) => [b.id, b]));
  const out: SkillContentItem[] = [];
  for (const id of ids) {
    const s = skillById.get(id);
    if (s) { out.push({ name: s.name, kind: "skill", content: s.prompt }); continue; }
    const b = kbById.get(id);
    if (b) out.push({ name: b.title, kind: "kb", content: b.content ?? "" });
  }
  return out;
}

// ── content embedding for share (#897 Phase 5b) ─────────────────────────────
// A shared blueprint references skills by id. To make it self-contained for KNOWLEDGE, the
// share bundles each attached item's full CONTENT (a SkillPayload), and the recipient
// reconstitutes them into their library so the id refs resolve. (MCP servers stay by reference
// — code, not content; they download from their catalog link on use.)

/** An attached skill/KB item, with enough content to faithfully reconstitute it on import. */
export interface SkillPayload {
  /** The library id — kept so the blueprint's refs resolve after reconstitution. */
  id: string;
  name: string;
  kind: "skill" | "kb";
  /** SkillDef.prompt / KbBlock.content. */
  content: string;
  desc?: string;
  tags?: string[];
  /** For a skill: its SkillDef.kind + tools, carried so reconstitution is faithful. */
  skillKind?: SkillKind;
  tools?: string[];
}

/** Every distinct skill/KB id a blueprint attaches (project-wide + every stage), order-preserving. */
export function collectBlueprintSkillIds(bp: Blueprint): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: string) => { if (!seen.has(id)) { seen.add(id); out.push(id); } };
  for (const id of bp.skills ?? []) add(id);
  for (const s of bp.sections) for (const id of s.skills ?? []) add(id);
  return out;
}

/** Resolve a blueprint's attached skill/KB ids to full {@link SkillPayload}s for embedding in a
 *  share. Missing ids (not in the library) are skipped. */
export function resolveBlueprintSkillPayloads(bp: Blueprint, skills: SkillDef[], kb: KbBlock[]): SkillPayload[] {
  const skillById = new Map(skills.map((s) => [s.id, s]));
  const kbById = new Map(kb.map((b) => [b.id, b]));
  const out: SkillPayload[] = [];
  for (const id of collectBlueprintSkillIds(bp)) {
    const s = skillById.get(id);
    if (s) { out.push({ id: s.id, name: s.name, kind: "skill", content: s.prompt, desc: s.desc, skillKind: s.kind, tools: s.tools }); continue; }
    const b = kbById.get(id);
    if (b) out.push({ id: b.id, name: b.title, kind: "kb", content: b.content ?? "", tags: b.tags });
  }
  return out;
}

/** Render a blueprint's attached skills (project-wide + per-stage) into a markdown doc
 *  the agents read (`skills.md`). Empty string when nothing is attached. */
export function buildSkillContext(bp: Blueprint, skills: SkillDef[], kb: KbBlock[]): string {
  const render = (items: SkillContentItem[]) =>
    items.map((i) => `### ${i.name} _(${i.kind})_\n\n${i.content.trim() || "_(no content)_"}`).join("\n\n");
  const blocks: string[] = [];
  const wide = resolveSkillContent(bp.skills ?? [], skills, kb);
  if (wide.length) blocks.push(`## Project-wide\n\n${render(wide)}`);
  for (const sec of bp.sections) {
    const items = resolveSkillContent(sec.skills ?? [], skills, kb);
    if (items.length) blocks.push(`## ${sec.name} stage\n\n${render(items)}`);
  }
  if (blocks.length === 0) return "";
  return `# Attached skills & knowledge\n\nReusable context paired with this project's blueprint — read the section relevant to the current stage.\n\n${blocks.join("\n\n")}\n`;
}

/** Resolve + write the blueprint's attached skills to the project hub's skills.md, where
 *  the planner (and downstream sessions) read them. No-op when nothing is attached. */
export async function writeBlueprintSkillContext(args: { projectKey: string; blueprint: Blueprint; skills: SkillDef[]; kb: KbBlock[] }): Promise<void> {
  const content = buildSkillContext(args.blueprint, args.skills, args.kb);
  if (!content) return;
  await writeProjectFile(args.projectKey, "skills.md", content);
}
