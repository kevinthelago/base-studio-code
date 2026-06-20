// Configurable shapes (#202) — a "shape" is a reusable plan-template: the same
// typed-node tree from the adaptive planning model (#201), at "template" maturity.
// Shapes come from a cascade of sources (built-in archetypes < user/org config <
// MCP-provided < project override < live adaptation) and are split into two tiers:
//
//   - default (advisory)  — proposed, freely droppable during shaping.
//   - policy  (mandatory) — enforced by the critic; can't be dropped silently.
//
// Configuration is a SEED, not a cage: it biases the adaptive shaping step, which
// still proposes-and-confirms on top. This module is the pure model — composition,
// tier rules, and policy validation. Free of React / xterm / Tauri imports
// (matches planNode.ts / shaping.ts).

import type { Maturity, PlanNode } from "../planNode";
import { layerTitle, type DimensionId, type LayerId } from "./shaping";

/** Advisory default vs mandatory policy. Policy is sticky across the cascade. */
export type Tier = "default" | "policy";

/** Where a shape (or layer) came from — informs precedence and trust. */
export type ShapeSource = "builtin" | "user" | "org" | "mcp" | "project";

/** A contract expected at a seam this layer owns/exposes. */
export interface ShapeContract {
  name: string;
  tier: Tier;
  note?: string;
}

/** A layer in a shape template — a PlanNode-to-be at template maturity, plus its tier. */
export interface ShapeLayer {
  /** Canonical {@link LayerId} or a custom layer id (e.g. an org's `audit`). */
  id: LayerId | string;
  title: string;
  tier: Tier;
  contracts?: ShapeContract[];
}

/** A reusable plan-template. */
export interface Shape {
  id: string;
  name: string;
  /** Compose on top of another shape (by id) — resolved by {@link resolveCascade}. */
  extends?: string;
  /** Dimensions this shape presumes (probe answers). */
  dimensions?: DimensionId[];
  layers: ShapeLayer[];
  source: ShapeSource;
}

// ── Tier helper ────────────────────────────────────────────────────────────────

/** Policy wins: once any source marks something policy, it stays policy. */
function mergeTier(a: Tier, b: Tier): Tier {
  return a === "policy" || b === "policy" ? "policy" : "default";
}

// ── Cascade composition ──────────────────────────────────────────────────────

function mergeContracts(a: ShapeContract[] = [], b: ShapeContract[] = []): ShapeContract[] {
  const byName = new Map<string, ShapeContract>();
  for (const c of a) byName.set(c.name, { ...c });
  for (const c of b) {
    const prev = byName.get(c.name);
    byName.set(c.name, prev ? { ...prev, ...c, tier: mergeTier(prev.tier, c.tier) } : { ...c });
  }
  return [...byName.values()];
}

function mergeLayer(a: ShapeLayer, b: ShapeLayer): ShapeLayer {
  return {
    ...a,
    ...b,
    tier: mergeTier(a.tier, b.tier),
    contracts: mergeContracts(a.contracts, b.contracts),
  };
}

/**
 * Compose a cascade of shapes (lowest precedence first) into one effective shape.
 * Layers union by id; a layer present in several sources takes the later source's
 * fields but the **strictest tier** (policy is sticky — a lower source can never
 * downgrade a higher source's policy). The cascade only **adds**; dropping an
 * advisory layer is live adaptation, not a config operation.
 */
export function composeShapes(cascade: Shape[]): Shape {
  if (cascade.length === 0) {
    return { id: "empty", name: "Empty", layers: [], source: "builtin" };
  }
  const layers = new Map<string, ShapeLayer>();
  const dimensions = new Set<DimensionId>();
  for (const shape of cascade) {
    for (const d of shape.dimensions ?? []) dimensions.add(d);
    for (const layer of shape.layers) {
      const prev = layers.get(layer.id);
      layers.set(layer.id, prev ? mergeLayer(prev, layer) : { ...layer });
    }
  }
  const top = cascade[cascade.length - 1];
  return {
    id: top.id,
    name: top.name,
    dimensions: dimensions.size ? [...dimensions] : undefined,
    layers: [...layers.values()],
    source: top.source,
  };
}

/**
 * Expand a shape's `extends` chain into a cascade [base…, shape], resolving against
 * a library keyed by id. Cycles and unknown bases are ignored (the chain stops).
 */
export function resolveCascade(shape: Shape, byId: Record<string, Shape>): Shape[] {
  const chain: Shape[] = [];
  const seen = new Set<string>();
  let cur: Shape | undefined = shape;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.extends ? byId[cur.extends] : undefined;
  }
  return chain;
}

// ── Shape → plan tree ────────────────────────────────────────────────────────

/** Turn a shape's layers into the initial plan tree (one `layer` node each). */
export function shapeToNodes(shape: Shape, maturity: Maturity = "stub"): PlanNode[] {
  return shape.layers.map((layer) => ({
    id: `layer:${layer.id}`,
    kind: "layer",
    title: layer.title,
    maturity,
    children: [],
  }));
}

// ── Policy validation (the critic's mandatory-coverage check) ──────────────────

export interface PolicyViolation {
  kind: "layer" | "contract";
  /** The policy layer id (and contract name, for contract violations). */
  layer: string;
  contract?: string;
}

/**
 * Check a plan against a shape's **policy** tier: every `policy` layer must be
 * present in the plan, and every `policy` contract within a present layer must be
 * accounted for. `presentLayerIds` is the set of layer ids the plan actually has;
 * `presentContractsByLayer` optionally maps a layer id to the contract names it
 * provides. Advisory (`default`) layers/contracts are never required.
 */
export function validateShapePolicy(
  shape: Shape,
  presentLayerIds: Iterable<string>,
  presentContractsByLayer: Record<string, Iterable<string>> = {},
): PolicyViolation[] {
  const present = new Set(presentLayerIds);
  const violations: PolicyViolation[] = [];
  for (const layer of shape.layers) {
    if (layer.tier === "policy" && !present.has(layer.id)) {
      violations.push({ kind: "layer", layer: layer.id });
      continue; // a missing layer subsumes its contracts
    }
    if (!present.has(layer.id)) continue;
    const have = new Set(presentContractsByLayer[layer.id] ?? []);
    for (const c of layer.contracts ?? []) {
      if (c.tier === "policy" && !have.has(c.name)) {
        violations.push({ kind: "contract", layer: layer.id, contract: c.name });
      }
    }
  }
  return violations;
}

// ── Built-in archetypes ────────────────────────────────────────────────────────

/** A canonical advisory layer for an archetype. */
function L(id: LayerId, tier: Tier = "default"): ShapeLayer {
  return { id, title: layerTitle(id), tier };
}

/**
 * The seed library of built-in archetypes. All layers are advisory `default` — the
 * adaptive shaping step proposes them and the user can drop any. Org/MCP shapes layer
 * policy on top via the cascade.
 */
export const BUILTIN_ARCHETYPES: Record<string, Shape> = {
  cli: {
    id: "cli",
    name: "CLI tool",
    dimensions: ["ui"],
    source: "builtin",
    layers: [L("presentation"), L("domain"), L("infra")],
  },
  library: {
    id: "library",
    name: "Library / SDK",
    source: "builtin",
    layers: [L("domain")],
  },
  "api-service": {
    id: "api-service",
    name: "API service",
    dimensions: ["api", "datastore", "auth"],
    source: "builtin",
    layers: [L("api"), L("domain"), L("data"), L("auth"), L("infra")],
  },
  "web-saas": {
    id: "web-saas",
    name: "Web SaaS",
    dimensions: ["ui", "api", "datastore", "auth"],
    source: "builtin",
    layers: [L("presentation"), L("api"), L("domain"), L("data"), L("auth"), L("integrations"), L("infra")],
  },
  mobile: {
    id: "mobile",
    name: "Mobile app",
    dimensions: ["ui", "api"],
    source: "builtin",
    layers: [L("presentation"), L("api"), L("domain")],
  },
};
