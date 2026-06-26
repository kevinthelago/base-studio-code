# Planning.tsx split plan (#1474)

`src/features/planner/session/Planning.tsx` is **2,814 lines**: ~51 `useState`/`useRef`,
**34 `useEffect`** blocks, and a handful of large async handlers. Only ~13% (≈360 lines) is JSX —
the bulk is **stateful wiring** (effects + handlers). So the split is primarily about extracting
**custom hooks**, not sub-components. Goal: **no behavior change**, shipped incrementally.

Extracted hooks live in a new `session/hooks/` dir; the pure parsing/derivation they call
already lives in `planningSession.ts` / `lib/planInjection.ts` / `lib/lintPlan.ts` / `stages/focusedPlan.ts`.

## The seams (concern clusters)

| Hook | Owns | Lines (approx) | Risk |
|---|---|---|---|
| `usePlannerTagStream` | the `pty_data` listener + all `<tag>` parsing (`bufRef`, `autopilotTxRef`) | 1242–1405 (~160) | **low** |
| `usePlanSectionPoll` | the 2s file + plan.db poll (issues/features/repos/phases/fleet/deploy/deps/mcp/blueprint) | 1549–1710 (~160) | **low** |
| `usePlanMcpManagement` | MCP toggle/add/remove/build + download modal + context write | scattered (~150) | low |
| `usePlannerRepoManagement` | auto-clone on link + `repoLinkFullNames` | 232–249 (~50) | low |
| `usePlannerTitle` | title/rename edit state + commit (published + draft) | 359–400 (~50) | low |
| `usePlanContextRequirements` | context required-set poll + seed | 967–999 (~40) | low |
| `usePlanSkillsManagement` | session skill-group sync + skills poll | 338–350 (~30) | low |
| `usePlanTunnel` | mobile relay sync (emit plan_state/status/event, PTY mirror, inbound drive) | 430–919 scattered (~100) | med |
| `usePlannerBlueprint` | blueprint binding/switch/modal/signature + restart/clear/regenerate | 174–1840 scattered (~200) | med |
| `usePlanPublish` | publish → GitHub + triage launch + recovery (`handlePublish` ~400 LOC alone) | 1847–2454 (~500) | med–high |
| `usePlannerPtyTerminal` | PTY spawn + xterm DOM + listener attach/cleanup | 1198–1540 (~320) | med |
| **`usePlanGates` (signals)** | `stageState` + `signals` + phase/gate derivation | 723–841 (~150) | **critical — defer** |
| `usePlanFocusedPane` | phase selection, footer, auto-confirm, skip | 837–1011 (~60) | high — defer |

## The choke point (why a clean full split needs a second step)

`sections`, `signals`, and `effectiveProjectId`/`effectiveBlueprintId` are read by **5+ clusters**
each (gates, phases, publish, pane, tunnel, GitHub structure). `signals` in particular is a derived
aggregate (`stageState` + `hasPlanGaps` + `injectionGate` + skip/confirm signals) consumed almost
everywhere. **Extracting the gate/signal derivation first would force passing its whole 10+ dep cloud
through every hook.** So we extract the *peripheral* concerns first (which only consume `signals`),
and defer the gate core until a `PlanningContext` provider can hold it — at which point consumers read
it from context instead of props.

## Extraction order (each step = its own behavior-preserving PR)

**Phase 1 — isolated, zero render impact (start here):**
1. `usePlannerTagStream` (the tag loop) — safest, highest-clarity win
2. `usePlanSectionPoll` (the 2s poll)
3. `usePlanMcpManagement`
4. `usePlannerRepoManagement`

**Phase 2 — small/medium, orthogonal:**
5. `usePlannerTitle` · 6. `usePlanContextRequirements` · 7. `usePlanSkillsManagement`
8. `usePlanTunnel` (pass `{sections, confirmedSet, currentStage, canonicalPlan}` as deps)
9. `usePlannerBlueprint` (pass PTY control callbacks)

**Phase 3 — the big async block:**
10. `usePlanPublish` (publish + triage + recovery; pass plan data as args, returns `{publishPhase, ghStatus, handlePublish, launchTriage, handleRecover}`)
11. `usePlannerPtyTerminal` (extract once the tag loop is already its own hook)

**Phase 4 — the core (deferred, needs `PlanningContext`):**
12. Introduce `PlanningContext` holding `sections`/`signals`/`phases`/gates.
13. `usePlanGates` + `usePlanFocusedPane` read from context; remaining consumers migrate.

**Phase 5 — optional JSX split:** `PlanningHeader` + `PlanningPanels` sub-components (after logic stabilizes; via context to avoid prop-drilling ~30 vars).

## Outcome

- After Phases 1–3: **2,814 → ~1,100–1,600 LOC** of resident wiring + JSX, with ~10 focused, testable hooks.
- Phase 4 unlocks the last ~200 LOC of gate logic behind a context boundary.
- Every step is independently shippable, green on typecheck/lint/test, and changes **no behavior**.

**Recommended first PR:** `usePlannerTagStream` (lines 1242–1405) — fully self-contained, ~160 LOC,
no render coupling.
