// The shaping step of the adaptive planning model (#201): derive a project's
// top-level layers from a few high-leverage, structure-branching dimension answers.
//
// "Layers are the top-level seams" — defining them early is finding the top-level
// seams. Each dimension a project answers "yes" to pulls in the layer(s) it implies;
// `domain` is always present. Most dimensions are inferred from a one-paragraph
// pitch — only the ambiguous ones are asked — but this module is just the pure
// mapping from answers to a proposed, stub-maturity layer set.
//
// Free of React / xterm / Tauri imports (matches planNode.ts / planSections.ts).

import type { Maturity, PlanNode } from "./planNode";

/** The canonical layers a project can decompose into. */
export type LayerId =
  | "presentation"
  | "api"
  | "domain"
  | "data"
  | "auth"
  | "realtime"
  | "jobs"
  | "integrations"
  | "ml"
  | "infra";

/** Stable render/order for layers, top (surface) to bottom (infra). */
export const LAYER_ORDER: readonly LayerId[] = [
  "presentation",
  "api",
  "domain",
  "data",
  "auth",
  "realtime",
  "jobs",
  "integrations",
  "ml",
  "infra",
] as const;

const LAYER_TITLES: Record<LayerId, string> = {
  presentation: "Presentation",
  api: "API",
  domain: "Domain",
  data: "Data",
  auth: "Auth & access",
  realtime: "Real-time",
  jobs: "Background jobs",
  integrations: "Integrations",
  ml: "ML / AI",
  infra: "Infrastructure",
};

/** Layers always present regardless of dimensions — every project has a core. */
export const CORE_LAYERS: readonly LayerId[] = ["domain"] as const;

/** The structure-branching dimensions probed during shaping. */
export type DimensionId =
  | "ui"
  | "api"
  | "datastore"
  | "auth"
  | "realtime"
  | "jobs"
  | "integrations"
  | "ml"
  | "infra";

export interface Dimension {
  id: DimensionId;
  /** The question asked when the answer can't be inferred from the pitch. */
  question: string;
  /** Layers a "yes" answer pulls in. */
  layers: LayerId[];
}

/** The dimension probe — few questions, each with a big structural payoff. */
export const DIMENSIONS: readonly Dimension[] = [
  { id: "ui", question: "Is there a user interface (web/mobile/desktop/CLI)?", layers: ["presentation"] },
  { id: "api", question: "Does it expose an API (REST/GraphQL/gRPC)?", layers: ["api"] },
  { id: "datastore", question: "Is there a persistent datastore?", layers: ["data"] },
  { id: "auth", question: "Are there users / authentication?", layers: ["auth"] },
  { id: "realtime", question: "Any real-time or streaming behavior?", layers: ["realtime"] },
  { id: "jobs", question: "Background jobs or queues?", layers: ["jobs"] },
  { id: "integrations", question: "Third-party integrations (payments/email/LLM/storage)?", layers: ["integrations"] },
  { id: "ml", question: "ML/AI components?", layers: ["ml"] },
  { id: "infra", question: "Custom infrastructure / IaC?", layers: ["infra"] },
] as const;

/** Answers to the dimension probe — absent keys are treated as "no". */
export type DimensionAnswers = Partial<Record<DimensionId, boolean>>;

const DIMENSION_BY_ID = new Map<DimensionId, Dimension>(DIMENSIONS.map((d) => [d.id, d]));

/**
 * Propose the top-level layer set for a project from its dimension answers: the
 * core layers plus the layers each "yes" dimension pulls in, deduped and returned
 * in canonical {@link LAYER_ORDER}.
 */
export function proposeLayers(answers: DimensionAnswers): LayerId[] {
  const set = new Set<LayerId>(CORE_LAYERS);
  for (const [id, yes] of Object.entries(answers) as [DimensionId, boolean | undefined][]) {
    if (!yes) continue;
    const dim = DIMENSION_BY_ID.get(id);
    if (dim) for (const layer of dim.layers) set.add(layer);
  }
  return LAYER_ORDER.filter((l) => set.has(l));
}

/** Human title for a layer. */
export function layerTitle(layer: LayerId): string {
  return LAYER_TITLES[layer];
}

/**
 * Turn proposed layers into the initial plan tree: one `layer` node per layer at
 * `stub` maturity, in canonical order, ready to be elaborated. Pure — the caller
 * wraps these under a project root.
 */
export function layersToNodes(layers: LayerId[], maturity: Maturity = "stub"): PlanNode[] {
  return layers.map((layer) => ({
    id: `layer:${layer}`,
    kind: "layer",
    title: LAYER_TITLES[layer],
    maturity,
    children: [],
  }));
}

/** Shape a project's initial layer nodes directly from dimension answers. */
export function shapeLayers(answers: DimensionAnswers): PlanNode[] {
  return layersToNodes(proposeLayers(answers));
}
