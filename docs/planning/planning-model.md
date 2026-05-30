# Adaptive planning model (#201)

The plan is a **tree of typed nodes**, derived for any project type and deepened
*as you go*. Not a fixed checklist, not a blank page — **derived structure with strong
defaults**. This document covers the pure model core (the rest of #201 — the interactive
shaping loop, elaboration UI, and decompose-to-FeatureContract wiring — builds on it).

## Typed-node tree (`planNode.ts`)

A `PlanNode` is `{ id, kind, title, maturity, summary?, children }`:

- **`kind`** — `layer | component | feature | contract | decision | risk | phase | …`.
  Extensible: any string is valid so a project can name a kind it needs.
- **`maturity`** — `stub → sketched → specified → contract-ready`. This is what gates
  work: only `contract-ready` work-kind nodes (`kickableNodes`) are eligible to become
  issues, so depth lands where it buys parallelism (the seams) and stays shallow
  elsewhere — "plan the next phase deep, sketch later" as a per-node property.

Helpers: `walk` / `flatten` / `findNode` (traversal), `maturityRank` / `atLeast`
(comparison), `rollupMaturity` (a parent is only as ready as its least-ready descendant),
and `progress` (contract-ready over total).

## Shaping step (`shaping.ts`)

The first step derives the project's **top-level layers** — which *are* the top-level
seams. A small set of structure-branching **dimensions** (`DIMENSIONS`) is probed (most
inferred from a one-paragraph pitch; only the ambiguous ones asked); each "yes" pulls in
the layer(s) it implies, on top of the always-present `domain` core:

```
proposeLayers({ ui: true, api: true, datastore: true })
  → ["presentation", "api", "domain", "data"]   // canonical LAYER_ORDER
```

`layersToNodes` / `shapeLayers` turn the proposed layers into the initial plan tree (one
`layer` node each, at `stub` maturity), ready to elaborate. The defaults come from a
configurable shape library and MCP providers (#202); this module is the pure mapping.

## How it connects

- Layers → epics; `feature` nodes at `contract-ready` → FeatureContract issues (#200).
- The `dependsOn`/contract edges feed the inter-session coordination DAG (#199).
- Discoverability (#205) surfaces gaps over this tree as it grows.
