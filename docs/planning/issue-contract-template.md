# Per-issue FeatureContract template

The canonical template for a planning-generated issue. Its one job: an agent should be
able to complete the issue reading **only the issue + the linked contract definitions**,
never a sibling's implementation. Two fields carry that weight — **Consumes** (the frozen
interfaces it calls) and **Produces** (the frozen surface it must expose); they are the
seams between components. Everything else supports them.

The structured form is `FeatureContract` in
`src/screens/projects/featureContract.ts`; `renderFeatureContract` emits this exact shape
as an issue body, and `validateContracts` checks the seams line up across a set (every
`consumes` resolves to a `produces`, no duplicate owners, no dangling `dependsOn`).

---

```markdown
# <imperative title, scoped to one region>  ·  stream: <id>  ·  phase: <n>

## Goal
<1–3 sentences: what this delivers and why. No implementation detail.>

## Acceptance criteria
- [ ] <testable "done when" — each maps to a verification below>

## Ownership boundary
Owns (may modify):
- `path/glob/**`
Do NOT modify outside these — another stream owns them; coordinate via contracts, not edits.

## Consumes (inbound — frozen; do not read their impl)
| Name | Defined in | Signature / shape |
|------|-----------|-------------------|
| `fnOrType` | `path:sym` | `exact signature / type` |
> Depend only on these signatures. If one is missing or wrong, that's a blocker — raise it.

## Produces (outbound — frozen for dependents)
| Name | Signature / shape | Errors / invariants |
|------|-------------------|---------------------|
| `fnOrType` | `exact signature` | `what can fail; what must hold` |
> Dependents rely on this exactly. Changing it later = a coordinated change.

## Data / schema / events touched
<tables, schemas, message types, event names this reads or writes>

## Skeleton / stubs to implement
<the specific files + stub fns from the kickoff scaffold this issue fills in>

## Verification
- Tests: <failing tests to make pass, or tests to add>
- Gate: `<exact command(s)>` must be green.

## Dependencies
- depends_on: #<ids that must land first — usually the contract owners>
- blocks: #<ids>

## Non-goals
- <explicit exclusions to stop scope bleed>

## References
- <links to plan sections / the contracts source of truth — not restated here>

## Notes
Where underspecified, make the smallest reversible choice consistent with the contracts
above and record it (`bsc-note`). Don't stop to ask.
```

---

## Why the two tables are load-bearing

A **Consumes** row is a seam: the agent is handed the *signature* of a dependency and told
not to read its implementation, so the issue stays context-local. A **Produces** row is the
frozen surface dependents build against — the thing the critic matches `consumes` against.
Specify these exhaustively; specify internals lightly (guidance, not mandates).

## Validation

`validateContracts(contracts)` reports:
- **dangling** — a `consumes.name` no feature `produces` (the agent has no source).
- **duplicateProduces** — one contract name produced by 2+ features (no single owner).
- **unknownDependencies** — a `dependsOn` that resolves to no feature in the set.

A plan that validates clean is one where every seam has exactly one owner and every
dependent has a real, frozen interface to build against.
