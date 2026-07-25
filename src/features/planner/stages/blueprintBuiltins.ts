// Built-in blueprint LIBRARY + stage defs (#513/#514, split out #2148): the runtime DATA
// behind the Blueprints page — the packaged stage/section defs (STAGE_DEFS), the category
// metadata, the section-instance builder (mkStage), and the assembly of the built-in blueprint
// library (makeBlueprints). Pure (no React/Tauri) so it's unit-testable and the store can seed
// from it directly. Types live in blueprintTypes.ts; the pure helpers in blueprintStages.ts.

import blueprintMetaEmbedded from "@data/planner/blueprint-meta.json";
import { overlayGlob, overlayFile } from "@/shared/lib/core/configOverrides";
import type {
  SectionDef, BlueprintStage, Blueprint, BlueprintDef, BlueprintCategory,
} from "./blueprintTypes";

// ── ids ──────────────────────────────────────────────────────────────────────
let _id = 0;
/** Ephemeral handle for a section/pipeline instance (stable within a session). */
export const uid = (p: string) => `${p}-${++_id}`;

// The blueprint-stage "pipeline" abstraction was removed in #897 Phase 4c: there was no
// production trigger engine, and the three surviving behaviors — render-preview, grade-plan,
// lint-plan — run by direct dispatch from their own modules. Capability now attaches to a
// blueprint as skills (#636) + MCP servers (#897); app-actions are the section `output`
// disposition + handlePublish.

// The canonical planning-stage data lives as one JSON file per stage under src-tauri/data/stages/
// (one file per key), the unified packaged-data root (#1462). Loaded + assembled into STAGE_DEFS here.
const sectionModules = import.meta.glob<{ default: SectionDef }>("@data/stages/*.json", { eager: true });

/** Every section definition, keyed by its filename stem (= the section key). The config-dir copy
 *  (#2047) overlays the Vite-embedded default per stage file. */
export const STAGE_DEFS: Record<string, SectionDef> = Object.fromEntries(overlayGlob("stages", sectionModules));

// The category list + display metadata load from @data/planner/blueprint-meta.json — the config-dir
// copy (#2047) overlays the embedded default, so it's editable without a rebuild + in the config bundle.
const blueprintMeta = overlayFile("planner/blueprint-meta.json", blueprintMetaEmbedded);
export const BLUEPRINT_CATEGORIES: BlueprintCategory[] = blueprintMeta.categories as BlueprintCategory[];

/** Display metadata per category (label + accent hue for the badge/filter). From blueprint-meta.json;
 *  `data` (#779) is the data-acquisition category, distinct from the software-lifecycle ones. */
export const CATEGORY_META: Record<BlueprintCategory, { label: string; h: number }> =
  blueprintMeta.categoryMeta as Record<BlueprintCategory, { label: string; h: number }>;

/** The packaged library kit id (= `REACT_UI_KIT_ID`) a greenfield app is built on — stamped as a
 *  built-in blueprint's consumer `kit` so `recordBlueprintKit` files the `kit_usage` edge (#2277/#2810).
 *  A literal (not a `@/features/designs` import) to keep `planner` decoupled from `designs`. */
const PACKAGED_KIT_ID = "react-ui";

/** Dedup a blueprint's section list by stage key — a hand-edited or imported blueprint could carry
 *  two sections with the same key; keep the first so the focused pane / gates resolve a single stage. */
export function dedupeSections(sections: BlueprintStage[]): BlueprintStage[] {
  const seen = new Set<string>();
  const out: BlueprintStage[] = [];
  for (const s of sections) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    out.push(s);
  }
  return out;
}

/** Build a section instance from a def key + per-blueprint overrides. */
export function mkStage(
  key: string,
  { enabled = true, expanded = false, optional }:
    { enabled?: boolean; expanded?: boolean; optional?: boolean } = {},
): BlueprintStage {
  const def = STAGE_DEFS[key];
  return {
    uid: uid("sec"), key, ...def, enabled, expanded,
    // explicit `optional` overrides the def's; otherwise inherit it
    optional: optional ?? def.optional,
  };
}

// The built-in blueprints live as one JSON file per blueprint under ./blueprints/ — each is just
// metadata + an ordered list of section keys that chain into ./sections/*.json (resolved below).
const blueprintModules = import.meta.glob<{ default: BlueprintDef }>("@data/blueprints/*.json", { eager: true });

/** The built-in blueprint library, assembled from the per-blueprint JSON definitions: ordered by
 *  each def`s `order`, with its section keys resolved into section instances via mkStage. */
export function makeBlueprints(): Blueprint[] {
  return overlayGlob("blueprints", blueprintModules)
    .map(([, def]) => def)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(({ order: _order, sections, ...meta }) => {
      // A GREENFIELD blueprint ships a fresh UI on the packaged kit, so record it as the app's consumer
      // `kit` (#2277/#2810): `recordBlueprintKit` then files the `kit_usage` edge at every bind, so a kit
      // change fans out to the project. An explicit `kit` in the def wins; operate-on-existing-repo
      // categories (transform/harden/maintain/data/script) aren't tied to a shared kit → no key added.
      const kit = meta.kit ?? (meta.category === "greenfield" ? PACKAGED_KIT_ID : undefined);
      return {
        ...meta,
        ...(kit ? { kit } : {}),
        sections: dedupeSections(sections.map((s) => mkStage(s.key, { optional: s.optional }))),
      };
    });
}
