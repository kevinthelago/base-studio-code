# Planning discoverability (#205)

Surface the *right* information at the moment it matters, so neither the user nor the
planning agent misses what they should have considered. Distinct from organization
(how the plan is structured): this is about *what surfaces, when*. Three axes (pure core
in `discoverability.ts`; the UI affordances build on it):

## Missing — the continuous critic (`findGaps`)
Run over the plan tree on every change. Emits typed `Gap`s with a **severity**:
- **`push`** (high-confidence, surfaced proactively as a quiet, non-blocking signal):
  policy violations (`policy-layer` / `policy-contract`, via `validateShapePolicy`),
  declared-but-`unaddressed-dimension`.
- **`pull`** (on-demand): soft `underspecified` nudges (a layer still at `stub`).
- **`external`** gaps are folded in as given — e.g. a dangling consume from #200's
  `validateContracts` (this module consumes the *result*, not #200's code).

`partitionGaps` splits push/pull; `topGaps` ranks the pushed set (most-actionable first)
and **caps** it — discoverability never fire-hoses.

## Relevant — node-scoped retrieval (`rankRelevant`)
Given the node you're on and a set of candidates (KB blocks, prior contracts, archetypes,
MCP templates…), rank by overlap between the candidate's tags and the node's terms
(kind + title + summary). Returns only matches, highest first, **capped**. Pull-first.

## Connected — navigate the plan (`searchNodes`)
Case-insensitive search over node titles + summaries. Maturity/kind filtering is a plain
`flatten(plan).filter(...)` (from `planNode`); the DAG/provenance overlay is the UI layer.

## The discipline
- **Push only high-confidence**; **pull everything else** (severity on each gap).
- **Rank and cap** (`topGaps`, `rankRelevant` cap) — top-few, not all.
- **Provenance** on every surfaced item (`Gap.provenance`, `Candidate.provenance`).

## Connections
Built on #201 (`PlanNode`) and #202 (`validateShapePolicy` / `Shape`); folds in #200's
contract gaps as input. The push/pull discipline + provenance match the issue's non-goals
(no firehose). DAG view shares the graph with #199.
