# Configurable execution topology (#204)

How plan nodes map onto the delivery substrate. **Milestones, branching, and assignment
are three projections of the same plan graph** — the *when*, the *where-code-lives*, and
the *who* — so they're configured together as coherent **strategy presets**, not 12
independent knobs (which let users build incoherent combos). The topology is *derived*
from (plan DAG + fleet + chosen strategy); this module is the strategy model, the
coherence critic, and branch naming (`executionTopology.ts`).

## Strategy

`ExecutionStrategy` = `{ milestoneAxis, branchGranularity, assignmentRule, mergeFlow }`:

- **milestoneAxis** — `phase | release | iteration` (the *when*).
- **branchGranularity** — `per-issue | per-stream | stacked | trunk` (the *where*).
- **assignmentRule** — `by-layer | by-dependency-wave | single-agent` (the *who*).
- **mergeFlow** — `trunk | develop-main | gitflow`.

### Presets (`STRATEGY_PRESETS`)

| Preset | Milestone | Branch | Assignment | Merge |
|---|---|---|---|---|
| solo-trunk | release | per-issue | single-agent | trunk |
| fleet-stream | phase | per-stream | by-layer | develop-main |
| stacked-dependency | phase | stacked | by-dependency-wave | develop-main |
| enterprise-gitflow | release | per-issue | by-layer | gitflow |

## Coherence critic

`validateStrategyCoherence(strategy)` rejects incoherent knob combinations (the reason to
expose presets, not free dropdowns). Returns `[]` when coherent:

- **stacked** branches follow the dependency DAG ⇒ assignment must be `by-dependency-wave`.
- **per-stream** branches mean an agent owns a stream/area ⇒ assignment must be `by-layer`.
- **single-agent** can't drive a multi-agent branch layout (`per-stream` / `stacked`).

## Branch naming

`branchNameFor(strategy, target)` always carries an id so the coordinator (#199) can map
**branch → issue/stream → DAG**: `per-stream` uses the stream id; everything else is
`{issue}-{slug(desc)}`. `slugify` lowercases, hyphenates, trims, and caps to 6 words.

## Connections

Derived from the planning model (#201) + `planFleet`; feeds the #199 coordination DAG.
Physical realization respects the capability profile (#203). Same cascade + advisory/policy
machinery as configurable shapes (#202) for org-level overrides.
