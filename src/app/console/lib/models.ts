// Shared LLM-model catalog (#…) — the single source of truth for the console's selectable model
// tiers, so the console (PaneMenu / PaneShell), Settings, and the planner's Permissions stage all
// reference one list instead of duplicating it. Each id maps to a Claude CLI tier alias at launch
// (`opus-4.5` → `claude --model opus`), so a tier tracks the latest model in that family.
import modelsEmbedded from "@data/console/models.json";
import modelDefaultsEmbedded from "@data/console/model-defaults.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";

/** A selectable model tier. The trailing version is cosmetic — the harness maps it to a CLI tier
 *  alias (`opus`/`sonnet`/`haiku`), which always resolves to the latest model in that tier. */
export type ModelId = "haiku-4.5" | "sonnet-4.5" | "opus-4.5";

export interface ModelOption {
  id: ModelId;
  /** One-word character of the tier (fast / balanced / deep). */
  tone: string;
  /** Relative-cost glyph. */
  price: string;
}

// The tier DATA is externalized to `@data/console/models.json` (#2146, epic #2027 tail) — editable
// without touching code + part of the exportable config bundle; the config-dir copy (#2047) overlays
// the embedded default via `overlayFile`. This module keeps the TYPES + accessor/derivation helpers.
/** The model tiers offered in the UI, cheapest → most capable. */
export const MODELS: ModelOption[] = overlayFile("console/models.json", modelsEmbedded as ModelOption[]);

export const MODEL_IDS: ModelId[] = MODELS.map((m) => m.id);

/** The default per-pane tier (the store's `defaultModel` seed + PaneShell's fallback), sourced from
 *  `@data/console/model-defaults.json` (#2416) — ONE default instead of scattered `"sonnet-4.5"`
 *  literals. Falls back to the catalog's middle tier if a config-dir edit names an unknown tier. */
export const DEFAULT_MODEL_ID: ModelId =
  MODEL_IDS.find((id) => id === overlayFile("console/model-defaults.json", modelDefaultsEmbedded).defaultTier) ??
  MODEL_IDS[Math.floor(MODEL_IDS.length / 2)];

/** The bare tier name a ModelId maps to ("opus-4.5" → "opus") — also the CLI alias. */
export function modelTier(id: ModelId): string {
  return id.split("-")[0];
}

/** Resolve a tier name back to its ModelId ("opus" → "opus-4.5"); undefined for an unknown tier. */
export function tierToModelId(tier: string): ModelId | undefined {
  return MODELS.find((m) => modelTier(m.id) === tier)?.id;
}
