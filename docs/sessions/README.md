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
| [kickoff-graph-migration.md](kickoff-graph-migration.md) | Brief to start the graph migration, local-first | **Done and then some** — the migration ran through this session; ~930 modules now ship as records. Current reference: [`../records.md`](../records.md) |
| [kickoff-retire-packaged-kit-artifact.md](kickoff-retire-packaged-kit-artifact.md) | Brief to retire `react-ui.json` for a DB-driven UI | Answered by the investigation below; `react-ui.json` is still packaged and still regenerated (`UPDATE_KITS=1`) |
| [investigation-retire-packaged-kit-artifact.md](investigation-retire-packaged-kit-artifact.md) | The answer to that kickoff | Superseded by what actually shipped |
| [kickoff-architect-orchestration.md](kickoff-architect-orchestration.md) | Brief for the architect-orchestration session | Consumed |
| [kickoff-sandbox-and-studio-path.md](kickoff-sandbox-and-studio-path.md) | Brief for sandbox-by-default + the planner/designer/librarian path | Partly delivered; sandbox-by-default is tracked as #4260 |
| [record-src-reconcile-triage.md](record-src-reconcile-triage.md) | Triage of record↔file provenance drift | **RESOLVED** — says so in its own title |
| [layouts-audit.md](layouts-audit.md) | Every page against the template set (epic #2197) | Point-in-time; several audited files are records now, including `GraphCanvas.tsx` |
| [ui-kit-coverage.md](ui-kit-coverage.md) | File-level comparison of the kit vs the frontend | Point-in-time, and structurally obsolete — it counts `.tsx` files, which is no longer what the frontend is made of |
| [project-plan-2026-05.md](project-plan-2026-05.md) | The checked-in product-plan snapshot, from `.github/` | Superseded by [`../../ROADMAP.md`](../../ROADMAP.md) and the roadmap table in `CLAUDE.md`; last touched 2026-05-27 |
