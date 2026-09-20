# Lane C triage — the plan lane, before any of it moves

MEASURED 2026-09-01. Every record under `src/features/planner/`: **126 records, 655,678 chars**. The split-3 kickoff sized this at 111 / 597,961 — it has drifted, so re-measure rather than trusting either number.

The kickoff asks for three groups. There are four: a quarter of the lane is **unreachable**, and porting a dead record is worse than porting a presentational one.

| group | records | chars | verdict |
|---|---:|---:|---|
| **D — unreachable** | 36 | 178,016 | nothing imports it; decide whether it should exist before anything else |
| **C — ported and bound** | 5 | 20,366 | a generated fixture already binds it to Rust; delete AFTER its callers flip |
| **A — domain over an owned resource** | 43 | 234,066 | migrate, in slices |
| **B — presentation** | 42 | 223,230 | stays in the renderer |

## How each verdict was reached

Recorded so a later session can challenge a row instead of re-deriving the lot:

- **Reachability** — for each record's `provides` specifier, a count of (i) other RECORDS whose code names it and (ii) non-test FILES under `src/` that import it. Both zero ⇒ group D. Records are most of this frontend, so counting only files would have called almost everything dead.
- **Binding** — the three generated contracts under `src/features/planner/` and whether a Rust file READS each. `classifyPredicates` and `classifyTaxonomy` are read by `plandb/classify.rs` and `validate.rs`; `plannerCore` by `mobile/tunnel/state.rs`. A fixture with no Rust reader is a contract with one signatory and does NOT make a record group C.
- **A vs B** — a first-pass judgement from each record's own header: does it decide something about a resource Rust owns (plan.db rows, worktrees, launches, publishes, the kit/persona/data stores), or does it shape that data for a screen? Each A row below carries its reason. This is the softest signal here and the one most worth arguing with.

## D — unreachable (do not port; decide whether to delete)

Nothing imports these: no record, and no non-test file. **The largest record in the lane is here.** `publishSteps.ts` (24,504) says in its own header that it was extracted from `usePlanPublish.ts`, and `delete-the-planner-ui-keep-the-planner` removed that UI; publishing is `crates/bsc-publish` now.

Three are imported only by their own tests — a test is not a caller, and a passing suite over dead code is exactly the green-that-covers-nothing this repo keeps finding.

**Deleting is NOT this item's call.** `docs/records.md` carries the preconditions for retiring anything, and `retire-module --dry` is the check; every one of those preconditions was learned by shipping the bug first.

| chars | record | test-only importer |
|---:|---|---|
| 24,504 | `publish-steps.ts` |  |
| 14,763 | `blueprint-share.ts` | yes |
| 11,105 | `projects-filter.ts` |  |
| 8,388 | `plan-features.ts` |  |
| 7,397 | `integration-gaps.ts` |  |
| 6,455 | `plan-autopilot.ts` |  |
| 5,685 | `bridge.ts` | yes |
| 5,504 | `runtime-fault.ts` |  |
| 4,953 | `recover-issues.ts` |  |
| 4,949 | `roadmap-gantt.ts` |  |
| 4,921 | `planner-launch.ts` |  |
| 4,886 | `blueprint-edit.ts` | yes |
| 4,644 | `html-renderer.ts` |  |
| 4,495 | `confirm-reconcile.ts` |  |
| 4,424 | `render-preview.ts` |  |
| 4,281 | `use-fleet-github.ts` |  |
| 4,197 | `source-discovery.ts` |  |
| 4,063 | `project-pane-data.ts` |  |
| 3,700 | `blueprint-mcp.ts` |  |
| 3,458 | `planner-fleet-graph-platform.ts` |  |
| 3,422 | `gltf-renderer.ts` |  |
| 3,362 | `blueprint-library.helpers.ts` |  |
| 3,217 | `pull-into-plan.ts` |  |
| 3,089 | `mcp-context.ts` |  |
| 3,026 | `rename-project.ts` |  |
| 2,836 | `project-scan.ts` |  |
| 2,775 | `planner-intro.ts` |  |
| 2,657 | `projects-summary-derive.ts` |  |
| 2,639 | `reopen-project.ts` |  |
| 2,593 | `drop-files.ts` |  |
| 2,407 | `plan-injection.ts` |  |
| 2,280 | `canvas-renderer.ts` |  |
| 2,197 | `planner-sandbox.ts` |  |
| 1,679 | `draft-title.ts` |  |
| 1,545 | `worker-detail-modal.ts` |  |
| 1,520 | `project-modes.ts` |  |

## C — ported and bound to Rust

A Rust file already reads the generated contract. These are deletable, but only once their callers move — `classifyConfig.ts` still has four live callers (`glanceGraph`, `plannerIndex`, `projectsFilter`, `useGlanceProjects`), so the flip comes first.

| chars | record | binding |
|---:|---|---|
| 15,692 | `classify-config.ts` | classifyPredicates + classifyTaxonomy fixtures; read by plandb/classify.rs and validate.rs |
| 1,652 | `planner-core-types.ts` | plannerCore.fixtures.json; read by mobile/tunnel/state.rs + tests.rs |
| 1,615 | `planner-core-manifest.ts` | plannerCore.fixtures.json; read by mobile/tunnel/state.rs + tests.rs |
| 930 | `planner-core-hash.ts` | plannerCore.fixtures.json; read by mobile/tunnel/state.rs + tests.rs |
| 477 | `planner-core-index.ts` | barrel over the bound plannerCore modules |

## A — domain over a resource Rust owns (migrate)

Take these in slices, biggest leverage first. The two worth starting with are the ones that are also security or correctness boundaries: `flowPermissions.ts` composes launch-time permission rules, and `workerScope.ts` builds the `CLAUDE.local.md` that `ensure_worktree` writes.

| chars | record | why it is domain |
|---:|---|---|
| 18,080 | `plan-fleet.ts` | fleet_stream rows + the parser for them |
| 12,504 | `sound-kit-pin.ts` | blueprint <-> sound-kit store link (bsc sound owns the store) |
| 11,654 | `deploy-services.ts` | the deployable-unit model per linked repo |
| 10,699 | `plan-issues.ts` | PlanIssue rows in plan.db |
| 10,373 | `deploy-coerce.ts` | parses the planner's <deploy_config> tag out of agent output |
| 9,848 | `relationship-graph.ts` | the coordination graph over fleet streams |
| 9,139 | `plan-stages.ts` | the canonical ordered stage set |
| 8,556 | `worker-scope.ts` | builds the worker's CLAUDE.local.md — ensure_worktree writes it |
| 8,539 | `ui-kit-pin.ts` | blueprint <-> UI-kit store link (bsc components owns the store) |
| 8,086 | `commons-gate.ts` | which lanes a stream is gated on |
| 7,579 | `feature-list.ts` | features ARE fleet streams, with a dependency DAG |
| 7,233 | `planner-conductor.ts` | drives the planner step by step |
| 7,010 | `data-model.ts` | canonical Data Model authoring; bsc data owns the model |
| 6,948 | `stage-gate.ts` | declarative completion gates over section state |
| 6,843 | `file-intake.ts` | classifies dropped design files into the intake dir Rust owns |
| 6,227 | `flow-kickoff.ts` | generates a stream's kickoff prose — the prompt Rust writes and launches |
| 6,044 | `team-fleet.ts` | team (persona graph) -> fleet streams |
| 5,298 | `dependency-manifests.ts` | publish-time manifest writers |
| 5,085 | `agent-flow.ts` | how a planned stream behaves at runtime |
| 5,068 | `repo-scaffold.ts` | publish-time repo scaffolding — bsc-publish territory |
| 4,332 | `director-drive.ts` | how the director session is driven |
| 4,325 | `repo-readme.ts` | publish-time README generation |
| 4,152 | `stream-persona.ts` | stream <-> persona resolution; bsc persona owns the store |
| 4,144 | `stack-topics.ts` | stack detection feeding publish |
| 3,943 | `data-model-derivation.ts` | source -> canonical Data Model; bsc data owns that model |
| 3,866 | `flow-permissions.ts` | a flow's launch-time PERMISSION rules — a security boundary |
| 3,801 | `dependency-parse.ts` | parses that manifest |
| 3,620 | `plan-board-projection.ts` | builds the `plan` store_state domain the tunnel pushes |
| 3,480 | `dependency-types.ts` | the planner-owned authoritative dependency manifest |
| 3,218 | `plan-extensions.ts` | assigns an MCP server to a project |
| 2,823 | `integration-strategy.ts` | fleet integration strategy |
| 2,665 | `fleet-policy.ts` | composes a stream's effective policy |
| 2,612 | `dependency-registry-config.ts` | registry config writers |
| 2,603 | `dependencies.ts` | the manifest model |
| 2,450 | `planning-session.ts` | the discovery loop's helpers |
| 2,385 | `deploy-platforms.ts` | the deploy target catalog |
| 2,094 | `dependency-worker-block.ts` | the locked set inlined into a worker's CLAUDE.local.md |
| 1,512 | `ids.ts` | stable project identifiers |
| 1,346 | `fleet-assignee.ts` | resolves the GitHub assignee for a published issue |
| 1,237 | `classification.ts` | discovery classification signal types |
| 1,067 | `deploy-config.ts` | the deployment config model |
| 958 | `plan-substeps.ts` | which substep the conductor is on |
| 620 | `readiness.ts` | the shared readiness-check shape |

## B — presentation of plan.db (stays)

View-models, page filters, palette metadata, render-shape contracts. Purity is what makes a move possible; owning the resource is what makes it right, and nothing here owns one.

| chars | record |
|---:|---|
| 22,370 | `blueprint-types.ts` |
| 16,047 | `blueprint-stages.ts` |
| 14,352 | `focused-plan.ts` |
| 9,519 | `gist.ts` |
| 8,943 | `preview-bundle.ts` |
| 8,888 | `transformations.ts` |
| 7,579 | `project-pane.types.ts` |
| 7,429 | `source-catalog.ts` |
| 7,044 | `market-config.ts` |
| 6,611 | `source-specs.ts` |
| 6,582 | `projects-db-bridge.ts` |
| 6,418 | `drafts.ts` |
| 6,184 | `gist-manifest.ts` |
| 5,566 | `streaming-runtime.ts` |
| 5,544 | `fleet-health.ts` |
| 5,416 | `deploy-env.ts` |
| 5,207 | `blueprint-catalog.ts` |
| 5,160 | `blueprint-skills.ts` |
| 5,017 | `gh-progress.ts` |
| 4,982 | `dependency-streams.ts` |
| 4,426 | `project-pane-agents.ts` |
| 4,051 | `fleet-cost.ts` |
| 3,997 | `source-gate.ts` |
| 3,944 | `project-pane-input.ts` |
| 3,787 | `source-scan-views.ts` |
| 3,781 | `mcp-pane-data.ts` |
| 3,464 | `project-pane-structure.ts` |
| 3,105 | `project-pane-relationships.ts` |
| 3,031 | `gh-structure.ts` |
| 2,910 | `source-config.ts` |
| 2,870 | `planner-index.tsx` |
| 2,806 | `stage-commands.ts` |
| 2,567 | `local-published.ts` |
| 2,234 | `dependency-sources.ts` |
| 2,062 | `published-model.ts` |
| 1,938 | `project-pane-context.ts` |
| 1,755 | `fleet-worker.ts` |
| 1,403 | `project-pane-repos.ts` |
| 1,394 | `stage-run.ts` |
| 1,301 | `blueprints.ts` |
| 1,139 | `preview-types.ts` |
| 407 | `worker-detail.helpers.ts` |

## Two cautions for whoever takes the A group

1. **Transitive death is not counted here.** Reachability was measured per record, so a live record whose only importer is a group-D record is itself dead and is currently classified A or B. The `pane/` cluster (7 records, ~26k) is the likeliest instance: it is the render-shape contract for the `ProjectPane` the planner-UI deletion removed.
2. **Vet before claiming, every time.** Three records were already ported when this lane was first read — the epic's own note records `streamGate.ts` failing all three checks *after* it had been claimed. Check for a Rust counterpart, a binding fixture, and the other side's tests.

## Unclassified — no `provides` specifier

3 of the 129 records carry no `provides`, so the reachability pass could not run on them and they are in none of the four groups above. That is a gap in this triage, not a verdict: a record with no specifier cannot be imported by name, which usually means it is a seed or an entry point rather than that it is dead. Resolve them before acting on group D.

| chars | record | src |
|---:|---|---|
| 2,125 | `preview-registry.ts` | `src/features/planner/preview/registry.ts` |
| 424 | `diff-manifests.ts` | `src/features/planner/lib/plannerCore/manifest.ts` |
| 174 | `fnv1a32.ts` | `src/features/planner/lib/plannerCore/hash.ts` |
