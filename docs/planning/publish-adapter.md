# Publish adapter (#226)

Turn a confirmed plan into the **ordered list of GitHub operations** that realize it,
choosing each operation's **physical representation** via the capability mapping (#203)
and the execution strategy (#204). Pure core (`publishAdapter.ts`): it computes *what* to
create (`PublishOp[]`); a separate side-effecting executor runs the `gh` calls (follow-on).

## Operations

`buildPublishPlan(input) → PublishOp[]`, ordered so each op is creatable when its turn
comes: **project → phases → labels → epics → dependencies**.

`PublishOp` = `project | milestone | iteration | label | epic | dependency`. Capability-
and strategy-aware choices:

- **phases** → `iteration` only when the strategy's milestone axis is `iteration` **and**
  Projects exist; otherwise `milestone`.
- **epics** → the highest supported epic rung (`mapConcept("epic", profile)`). On a
  personal account that's `parent+sub-issues+label`, which also emits an `epic` label;
  on an org it's `issue-type+sub-issues` (no extra label).
- **dependencies** → the highest supported dependency rung (native relationship → Project
  field → body text).

`summarizePlan(ops)` returns op counts by kind — a compact preview of what a publish does.

## Why pure / op-list

Computing the op list separately from executing it means the publish is **previewable**,
**testable**, and **idempotent to design** — and it's the same plan that re-publishes
against a richer capability profile with no change (just different chosen rungs).

## Connections

Consumes #203 (`mapConcept` / `CapabilityProfile`) and #204 (`ExecutionStrategy`). Inputs
come from the planning model (#201) + `ghStructure` + `planFleet`. Dependency ops feed the
#199 coordination DAG once issues exist.
