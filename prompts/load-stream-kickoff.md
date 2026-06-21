# Load stream — kickoff

You are the **load-stream** worker. Your job is the build-time migration pipeline:
map, clean, and load records into the DuckDB canonical Data Model with per-field lineage,
and surface the reconcile backend in the UI.

## Contract (build against it, in parallel)

You build against **source-experience**'s contract: the `data_load_reconciled` Tauri command,
whose signature the plan specifies. Implement your work to that contract **in parallel** — do NOT
wait for source-experience to land. If its stub isn't present yet, build to the agreed signature
(stub it locally if you need it to compile); integration is verified when both streams land.

## Your lane

Read `CLAUDE.local.md` for your exact owned files and issues.
Do not modify files outside your owned paths — another stream owns them;
coordinate through the director instead.

## Issues (work in order)

### ls-stream — fleet wiring

`fleetStartProject` already creates a worktree for any `AgentStream` in the fleet plan;
the load stream is wired by the planner authoring a stream with:

- `id: "load-stream"`
- `owns`: the files in your CLAUDE.local.md
- `dependsOn: ["source-experience"]`
- `issues: ["ls-stream", "ls-reconcile-ui", "ls-lineage-verify"]`
- `prompt: "prompts/load-stream-kickoff.md"` (this file)

`ensure_worktree` seeds the worktree via `scope_md` (built from the stream's
owns/issues/dependsOn by `buildWorkerScope`). No changes to `ensure_worktree` are
needed — the generic mechanism already handles this stream.

Write `src/__tests__/loadStream.test.ts` — a Vitest store unit test that:
- Builds a `FleetPlan` containing the load-stream `AgentStream`
- Calls `useAppStore.getState().fleetStartProject(...)`
- Asserts `paneRoleGlobs` contains the load-stream's owned paths
- Asserts `fleetPaneStreams` records the stream
- Asserts `paneStartupPromptDocs` points to the kickoff relpath

### ls-reconcile-ui — LoadReconcile.tsx

Build `src/screens/projects/LoadReconcile.tsx`. It must:

- Accept `projectKey`, `model` (DataModel), and `entityKey` as props
- Invoke `data_load_reconciled` to fetch the reconciled records and per-field lineage
- Render a table of records with per-field lineage attribution (source / loaded_at / license)
  for each field that has a winning value
- Run a **quality gate**: for each `Field` with a `validate` rule, check the field value
  against the rule; rows that fail any required-field check are **quarantined** (shown
  separately) and excluded from the load count
- Show a "Verify load" button only when the quarantine list is empty
- Clicking "Verify load" calls `store.setLoadVerified(projectKey, entityKey, true)` and
  shows a verified banner

Write RTL tests in `src/__tests__/loadReconcile.test.tsx`:
- Lineage view renders per-field source attribution
- A quality-gate failure quarantines the record and hides "Verify load"
- When quarantine is empty, "Verify load" is visible and clicking it flips the store flag

### ls-lineage-verify — reconcile.rs + ddl.rs

(Already implemented in this worktree — see `crates/data/src/reconcile.rs`
and `crates/data/src/ddl.rs`.)

## Autonomy rules

- Record micro-decisions with `bsc-note`.
- Run `npm test`, `npm run typecheck`, and `cargo test` before finishing.
- Self-merge to develop: rebase onto develop → re-gate → push.
- Do NOT open a PR; do NOT ask the user for direction.
- When you pause, pipe a short resume note into `bsc-checkpoint`.
