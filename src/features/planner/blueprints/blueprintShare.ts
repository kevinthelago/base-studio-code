// Blueprint ⇄ extension-manifest bridge (#598). Wraps a blueprint in the generic
// envelope for export/share, and tolerantly reconstructs a blueprint from an imported
// manifest (fresh uids, defensive field coercion — never trusts the payload shape).
// Pure; pairs with lib/gist/manifest.ts.

import { type Blueprint, type BlueprintStage, uid } from "../stages/blueprints";
import { wrapExtension, type ExtensionManifest } from "@/features/planner/lib/gist/manifest";
import { type SkillPayload } from "./blueprintSkills";

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const BP_CATEGORIES = ["greenfield", "transform", "harden", "maintain", "data"] as const;
const BP_MODES = ["create", "operate"] as const;

function coerceSection(v: unknown): BlueprintStage | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const key = str(o.key);
  const name = str(o.name);
  if (!key || !name) return null;
  return {
    uid: uid("sec"), key, name,
    glyph: str(o.glyph, "✚"),
    icon: str(o.icon, "category"),
    hue: typeof o.hue === "number" ? o.hue : 250,
    gate: str(o.gate, "stage complete"),
    deps: strArr(o.deps),
    blurb: str(o.blurb),
    prompt: str(o.prompt),
    enabled: o.enabled !== false,
    expanded: false,
    // Attached capabilities (#897) — preserve the section's skill ids + MCP server names so a
    // shared blueprint carries its tools/knowledge instead of silently dropping them on import.
    skills: strArr(o.skills),
    mcp: strArr(o.mcp),
    // Carry the optional flag + output disposition so the stage's shape/behavior survives a share.
    ...(typeof o.optional === "boolean" ? { optional: o.optional } : {}),
    ...(str(o.output) ? { output: str(o.output) } : {}),
  };
}

/** Reconstruct a Blueprint from an untrusted payload, or null if it's not one. Requires an id, a
 *  name, and (by default) at least one valid section; assigns fresh uids.
 *
 *  `allowEmptySections` (#923) accepts a section-less blueprint — used for the IN-PROGRESS blueprint
 *  an authoring session emits via the `<blueprint>` tag, which has its identity (name/category) at
 *  the Purpose stage before any stages are designed. Import stays strict (≥1 section). */
export function coerceBlueprint(
  payload: unknown,
  { allowEmptySections = false }: { allowEmptySections?: boolean } = {},
): Blueprint | null {
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  const id = str(o.id);
  const name = str(o.name);
  if (!id || !name) return null;
  // Accept `stages` (the planner-facing name — matching the design, the UI, and the planning-process
  // concept) OR the internal `sections` field (#923): they're the same thing — the ordered planning
  // STAGES, one per project pane. (NOT the per-stage context files, which a stage like Context
  // produces itself.) The internal model keeps the field name `sections`.
  const rawStages = Array.isArray(o.stages) ? o.stages : Array.isArray(o.sections) ? o.sections : [];
  const sections = rawStages.map(coerceSection).filter(Boolean) as BlueprintStage[];
  if (sections.length === 0 && !allowEmptySections) return null;
  const category = (BP_CATEGORIES as readonly string[]).includes(str(o.category))
    ? (str(o.category) as Blueprint["category"]) : undefined;
  const mode = (BP_MODES as readonly string[]).includes(str(o.mode))
    ? (str(o.mode) as Blueprint["mode"]) : undefined;
  const VIS = ["local", "private-gist", "catalog"] as const;
  const visibility = (VIS as readonly string[]).includes(str(o.visibility))
    ? (str(o.visibility) as Blueprint["visibility"]) : undefined;
  return {
    id, name, desc: str(o.desc), sections,
    // Blueprint-wide attached capabilities (#897) + lifecycle metadata, preserved on import.
    skills: strArr(o.skills),
    mcp: strArr(o.mcp),
    // Authoring metadata (#923): catalog pitch/audience/tags/visibility + accent hue/icon.
    ...(str(o.pitch) ? { pitch: str(o.pitch) } : {}),
    ...(str(o.audience) ? { audience: str(o.audience) } : {}),
    ...(visibility ? { visibility } : {}),
    ...(strArr(o.tags).length ? { tags: strArr(o.tags) } : {}),
    ...(typeof o.h === "number" ? { h: o.h } : {}),
    ...(str(o.icon) ? { icon: str(o.icon) } : {}),
    ...(category ? { category } : {}),
    ...(mode ? { mode } : {}),
  };
}

/** Wrap a blueprint in the extension envelope for export / share / publish. When `bundledSkills`
 *  is given (#897 Phase 5b), the attached skills' CONTENT travels in the payload so the share is
 *  self-contained for knowledge; the recipient reconstitutes them into their library on import.
 *  (MCP servers stay by reference — they download from their catalog link, not the gist.) */
export function blueprintToManifest(bp: Blueprint, bundledSkills: SkillPayload[] = []): ExtensionManifest<Blueprint> {
  const payload = bundledSkills.length ? { ...bp, bundledSkills } : bp;
  return wrapExtension("blueprint", bp.id, bp.name, "1.0.0", payload, { description: bp.desc });
}

/** Coerce embedded skill content out of a shared manifest's payload (#897 Phase 5b). Tolerant of
 *  an absent/old payload (returns []). Each item keeps its id so the blueprint's refs resolve. */
export function bundledSkillsFromManifest(m: ExtensionManifest): SkillPayload[] {
  const raw = (m?.payload as { bundledSkills?: unknown } | undefined)?.bundledSkills;
  if (!Array.isArray(raw)) return [];
  const out: SkillPayload[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const id = str(o.id);
    const name = str(o.name);
    if (!id || !name) continue;
    // KB blocks were retired (#1460); a legacy "kb" payload reconstitutes as a skill.
    out.push({
      id, name, kind: "skill", content: str(o.content), desc: str(o.desc) || undefined,
      ...(Array.isArray(o.tags) ? { tags: strArr(o.tags) } : {}),
      ...(str(o.skillKind) ? { skillKind: str(o.skillKind) as SkillPayload["skillKind"] } : {}),
      ...(Array.isArray(o.tools) ? { tools: strArr(o.tools) } : {}),
    });
  }
  return out;
}

/** Reconstruct a blueprint from a validated manifest. The store assigns a fresh
 *  blueprint id on import, so a same-id collision can never overwrite an existing one. */
export function manifestToBlueprint(
  m: ExtensionManifest,
): { ok: true; blueprint: Blueprint } | { ok: false; error: string } {
  if (m.kind !== "blueprint") return { ok: false, error: `expected a blueprint, got '${m.kind}'` };
  const blueprint = coerceBlueprint(m.payload);
  if (!blueprint) return { ok: false, error: "blueprint payload is malformed (need id, name, and ≥1 valid section)" };
  return { ok: true, blueprint };
}
