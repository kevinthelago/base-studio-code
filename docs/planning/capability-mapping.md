# Capability-aware GitHub mapping (#203)

Separate the **logical** plan structure from the **physical** GitHub primitives, and bind
the mapping **late** — per the connected account's capabilities. The planner only ever
works in logical concepts (`epic`, `hierarchy`, `dependency`, `phase`, `stream`,
`issue-type`); a capability-aware adapter picks the physical representation, degrading
gracefully when a richer primitive isn't available.

This is the answer to "prepare for both": the same logical plan re-publishes against a
richer profile (e.g. moving a personal repo under an org) with **no plan change**. Pure
core in `capabilityMapping.ts`; detection + the publish adapter build on it.

## Capability profile

`CapabilityProfile` = `{ accountType, subIssues, issueTypes, nativeDependencies, projects }`,
detected on connect and cached. `personalProfile()` (sub-issues yes, issue types no) and
`orgProfile()` (everything) are presets; `detectProfile(raw)` builds one conservatively and
**never grants issue types to a user account** (they're org-only).

## Degradation ladder

Each concept has a ladder, richest rung first; the last rung is always supported.
`mapConcept(concept, profile)` returns the **highest supported rung**:

| Concept | org-rich | personal | fallback |
|---|---|---|---|
| epic | Epic type + sub-issues | parent + sub-issues + label | parent + task-list |
| issue-type | custom type | `type:*` label | — |
| hierarchy | sub-issues (rollup) | sub-issues (rollup) | task-lists |
| dependency | native relationship | Project field | body `depends_on:` |
| phase | Project iteration | Project iteration | milestone |
| stream | label + epic parent | label + epic parent | label |

On a personal account you lose almost nothing structurally — sub-issues give hierarchy +
rollup; only native *type* labeling degrades to a label, and the DAG to a Project field
(which the #199 coordinator already reads).

## API

- `mapConcept(concept, profile) → Rung` — the chosen physical representation.
- `summarizeMapping(profile)` — concept → rung id, the whole mapping.
- `ladderFor(concept)` — the ladder (for UI / provenance: "modeled as X because no org").

## Connections

The publish step of the planning model (#201) uses this adapter. Dependency fallback feeds
the #199 coordination DAG. A tracker-independent logical layer also opens non-GitHub
adapters later (not a goal; a free consequence).
