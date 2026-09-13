# Session artifacts

Documents written **for one moment** — a kickoff brief handed to the next session, an investigation
answering one, a point-in-time audit. They were true when written and are not maintained.

They live here rather than in `docs/` because that directory is now a promise: **everything in `docs/` is
meant to stay true.** Mixing the two kinds meant a reader could not tell which was which, and the staleness
concentrated in exactly the documents nobody was going to update — `ui-kit-coverage.md` compares "every
non-test `.tsx` under `src/`" against the kit, and most of those files are now records rather than files
(see [`../records.md`](../records.md)).

They are **kept, not deleted.** A kickoff records what was believed at the start of a piece of work, which
is the part git history is worst at reconstructing. Each one below carries a banner saying what became of it.

This is *not* [`../archive/`](../archive/README.md) — that directory holds archived GitHub **issues**, one
file per cluster, so historical `(#N)` references can still be resolved.

| Document | What it was | Outcome |
|---|---|---|
| [kickoff-records-migration.md](kickoff-records-migration.md) | Brief to start the records migration, plus a defect to fix before more retirements | **Done** — 1,004 modules ship as records now (337 component + 667 impl). Current reference: [`../records.md`](../records.md) |
| [kickoff-records-migration-2.md](kickoff-records-migration-2.md) | Brief to finish that migration across two sessions | Delivered; see part one |
| [proposal-teams-owns-agent-configuration.md](proposal-teams-owns-agent-configuration.md) | Proposal to collapse roles + personas + permissions onto Teams — the first slice of a "seven pages" refactor | Never implemented as written. The direction arrived another way: personas are READ on Teams, `bsc persona` writes, and the rail is nine Workspaces, not seven pages. The capability collapse is `the-persona-is-the-whole-agent` |
| [review-rust-graph-migration.md](review-rust-graph-migration.md) | Point-in-time survey of the Rust tree for records-migration opportunities (2026-08-19) | The direction happened — 204 rust implementations in the graph, and `npm run gate` compiles the rust nodes every run |
| [methodology-rust-compiled-nodes.md](methodology-rust-compiled-nodes.md) | Can a node carry its compiled counterpart? | Yes — `bsc graph build` compiles from a node's composes closure and stamps the verdict. The wider work is the open epic `epic-compiled-nodes-carry-their-artifact` |
| [kickoff-graph-migration.md](kickoff-graph-migration.md) | Brief to start the graph migration, local-first | **Done and then some** — the migration ran through this session; ~930 modules now ship as records. Current reference: [`../records.md`](../records.md) |
| [kickoff-retire-packaged-kit-artifact.md](kickoff-retire-packaged-kit-artifact.md) | Brief to retire `react-ui.json` for a DB-driven UI | Answered by the investigation below; `react-ui.json` is still packaged and still regenerated (`UPDATE_KITS=1`) |
| [investigation-retire-packaged-kit-artifact.md](investigation-retire-packaged-kit-artifact.md) | The answer to that kickoff | Superseded by what actually shipped |
| [kickoff-architect-orchestration.md](kickoff-architect-orchestration.md) | Brief for the architect-orchestration session | Consumed |
| [kickoff-sandbox-and-studio-path.md](kickoff-sandbox-and-studio-path.md) | Brief for sandbox-by-default + the planner/designer/librarian path | Partly delivered; sandbox-by-default is tracked as #4260 |
| [record-src-reconcile-triage.md](record-src-reconcile-triage.md) | Triage of record↔file provenance drift | **RESOLVED** — says so in its own title |
| [layouts-audit.md](layouts-audit.md) | Every page against the template set (epic #2197) | Point-in-time; several audited files are records now, including `GraphCanvas.tsx` |
| [ui-kit-coverage.md](ui-kit-coverage.md) | File-level comparison of the kit vs the frontend | Point-in-time, and structurally obsolete — it counts `.tsx` files, which is no longer what the frontend is made of |
| [project-plan-2026-05.md](project-plan-2026-05.md) | The checked-in product-plan snapshot, from `.github/` | Superseded by [`../../ROADMAP.md`](../../ROADMAP.md) and the roadmap table in `CLAUDE.md`; last touched 2026-05-27 |
| [debug-phone-to-ear-stream.md](debug-phone-to-ear-stream.md) | Debug session getting the phone's microphone into `bsc ear` — the two-seeds/two-keypairs blocker that was not in the brief, and nine method lessons about green results that were not evidence | Code landed as `one-pairing-assigns-every-room`; the stream itself was **not** run end-to-end at the time of writing. Outstanding: `the-phone-joins-a-feature-room-only-when-it-wants-that-feature` and `a-tauri-event-with-no-listener-is-a-void-and-nothing-catches-it` |

Five of these arrived late: `HANDOFF-*`, `PROPOSAL-*` and `RUST-GRAPH-*` sat at the REPO ROOT until
2026-08-24, which is exactly the confusion this directory exists to prevent — a reader at the root
could not tell a maintained promise from a document written for one afternoon. They were moved here
with the banners above rather than deleted, per the rule at the top of this file.
