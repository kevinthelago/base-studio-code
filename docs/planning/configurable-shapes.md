# Configurable shapes (#202)

A **shape** is a reusable **plan-template** — the same typed-node tree from the planning
model (#201), at "template" maturity. Configuring a shape and authoring a plan use one
model; a shape is a partially-filled plan you clone and adapt. This document covers the
pure model core (`shape.ts`); the Settings/Knowledge-Store UI and the MCP shape-provider
wiring build on it.

## Seed, not cage

Configuration **biases** the adaptive shaping step (#201) — it never replaces propose-and-
confirm. The reframe: *derived structure with strong defaults*, not a fixed checklist.

## Two tiers

- **`default` (advisory)** — proposed, freely droppable during shaping.
- **`policy` (mandatory)** — enforced by the critic (`validateShapePolicy`); can't be
  dropped silently. **Policy is sticky**: once any source in the cascade marks a
  layer/contract policy, a lower-precedence source can never downgrade it.

## The cascade

Shapes compose lowest-precedence-first:

```
built-in archetypes  <  user/org config  <  MCP-provided  <  project override  <  live adaptation
```

`composeShapes(cascade)` unions layers by id (a shared layer takes the later source's
fields but the strictest tier) and unions dimensions. `resolveCascade(shape, library)`
expands a shape's `extends` chain into that ordered cascade. The cascade only **adds** —
dropping an advisory layer is live adaptation, not a config operation.

## API

- `composeShapes(cascade) → Shape` — fold the cascade into one effective shape.
- `resolveCascade(shape, byId) → Shape[]` — expand `extends` into the cascade.
- `shapeToNodes(shape) → PlanNode[]` — seed the plan tree (one `layer` node each).
- `validateShapePolicy(shape, presentLayers, presentContractsByLayer?) → PolicyViolation[]`
  — the critic's mandatory-coverage check (missing policy layers/contracts).
- `BUILTIN_ARCHETYPES` — the seed library (CLI, library, api-service, web-saas, mobile),
  all advisory; org/MCP layer policy on top.

## Connections

- Built on #201 (`PlanNode` / `LayerId`).
- Defaults feed the shaping step (#201); policy is enforced by the same critic that
  validates a generated plan.
- MCP servers contribute shapes / enforce policy via the cascade (separate wiring);
  policy-enforcing MCPs ride a higher trust tier (#158 / `scope:security`).
