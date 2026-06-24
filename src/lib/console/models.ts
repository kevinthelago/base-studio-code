// Shared LLM-model catalog (#…) — the single source of truth for the console's selectable model
// tiers, so the console (PaneMenu / PaneShell), Settings, and the planner's Permissions stage all
// reference one list instead of duplicating it. Each id maps to a Claude CLI tier alias at launch
// (`opus-4.5` → `claude --model opus`), so a tier tracks the latest model in that family.

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

/** The model tiers offered in the UI, cheapest → most capable. */
export const MODELS: ModelOption[] = [
  { id: "haiku-4.5",  tone: "fast",     price: "$"   },
  { id: "sonnet-4.5", tone: "balanced", price: "$$"  },
  { id: "opus-4.5",   tone: "deep",     price: "$$$" },
];

export const MODEL_IDS: ModelId[] = MODELS.map((m) => m.id);

/** The bare tier name a ModelId maps to ("opus-4.5" → "opus") — also the CLI alias. */
export function modelTier(id: ModelId): string {
  return id.split("-")[0];
}

/** Resolve a tier name back to its ModelId ("opus" → "opus-4.5"); undefined for an unknown tier. */
export function tierToModelId(tier: string): ModelId | undefined {
  return MODELS.find((m) => modelTier(m.id) === tier)?.id;
}
