# Planning.tsx split plan (#1474)

`src/features/planner/session/Planning.tsx` is **2,164 lines** (down from 2,814 when this plan was
written): ~23 `useState` / ~16 `useRef`, **25 `useEffect`** blocks, and a handful of large async
handlers. Only a small fraction is JSX — the bulk is **stateful wiring** (effects + handlers). So the
split is primarily about extracting **custom hooks**, not sub-components. Goal: **no behavior change**,
shipped incrementally.

Extracted hooks live **directly in `session/`** (not a `session/hooks/` subdir); the pure
parsing/derivation they call already lives in `planningSession.ts` / `lib/planInjection.ts` /
`lib/lintPlan.ts` / `stages/focusedPlan.ts`.

## Status (#1525 refresh)

**Done — extracted as files in `session/`** (9): `usePlannerTagStream`, `usePlanSectionPoll`,
`usePlanMcpManagement` (+ `usePlanMcpDownloads`, split out alongside it), `usePlannerRepoManagement`,
`usePlanSkillsManagement`, `usePlannerBlueprint`, `usePlannerPromptDelivery` (new — not in the original
seam table), and `usePlanGates` — which was marked *"critical — defer"* below but was in fact extracted
early.

**Remaining** (7): `usePlannerTitle`, `usePlanContextRequirements`, `usePlanTunnel`, `usePlanPublish`,
`usePlannerPtyTerminal`, `usePlanFocusedPane`, and the `PlanningContext` provider (no `createContext`
exists in `planner/` yet — the `setPlanningContext` store action is unrelated).

## The seams (concern clusters)

> Line-number references below were accurate against the 2,814-line original and are now approximate —
> treat them as a rough locator, not exact ranges.

| Hook | Owns | Status | Risk |
|---|---|---|---|
| `usePlannerTagStream` | the `pty_data` listener + all `<tag>` parsing (`bufRef`, `autopilotTxRef`) | ✅ done | low |
| `usePlanSectionPoll` | the 2s file + plan.db poll (issues/features/repos/phases/fleet/deploy/deps/mcp/blueprint) | ✅ done | low |
| `usePlanMcpManagement` | MCP toggle/add/remove/build + download modal + context write | ✅ done | low |
| `usePlannerRepoManagement` | auto-clone on link + `repoLinkFullNames` | ✅ done | low |
| `usePlanSkillsManagement` | session skill-group sync + skills poll | ✅ done | low |
| `usePlannerBlueprint` | blueprint binding/switch/modal/signature + restart/clear/regenerate | ✅ done | med |
| `usePlannerPromptDelivery` | startup-prompt delivery (baked into launch, not typed post-idle) | ✅ done | low |
| `usePlanGates` (signals) | `stageState` + `signals` + phase/gate derivation | ✅ done (was deferred) | critical |
| `usePlannerTitle` | title/rename edit state + commit (published + draft) | ⬜ todo | low |
| `usePlanContextRequirements` | context required-set poll + seed | ⬜ todo | low |
| `usePlanTunnel` | mobile relay sync (emit plan_state/status/event, PTY mirror, inbound drive) | ⬜ todo | med |
| `usePlanPublish` | publish → GitHub + triage launch + recovery (`handlePublish` ~400 LOC alone) | ⬜ todo | med–high |
| `usePlannerPtyTerminal` | PTY spawn + xterm DOM + listener attach/cleanup | ⬜ todo | med |
| `usePlanFocusedPane` | phase selection, footer, auto-confirm, skip | ⬜ todo | high |

## The choke point (why a clean full split needs a second step)

`sections`, `signals`, and `effectiveProjectId`/`effectiveBlueprintId` are read by **5+ clusters**
each (gates, phases, publish, pane, tunnel, GitHub structure). `signals` in particular is a derived
aggregate (`stageState` + `hasPlanGaps` + `injectionGate` + skip/confirm signals) consumed almost
everywhere. The original plan deferred the gate/signal core for last (to avoid threading its 10+ dep
cloud through every hook) and pulled the *peripheral* concerns out first. In practice `usePlanGates`
was extracted ahead of that deferral; a `PlanningContext` provider to hold `sections`/`signals` and
let consumers read from context (instead of props) is still the intended landing spot for the
remaining gate/pane consumers.

## Extraction order (each step = its own behavior-preserving PR)

**Phase 1 — isolated, zero render impact:** ✅ done
1. `usePlannerTagStream` (the tag loop) · 2. `usePlanSectionPoll` (the 2s poll) ·
3. `usePlanMcpManagement` · 4. `usePlannerRepoManagement`

**Phase 2 — small/medium, orthogonal:** partially done
- ✅ `usePlanSkillsManagement`, `usePlannerBlueprint`, `usePlannerPromptDelivery`
- ⬜ `usePlannerTitle` · `usePlanContextRequirements` · `usePlanTunnel`
  (pass `{sections, confirmedSet, currentStage, canonicalPlan}` as deps)

**Phase 3 — the big async block:** ⬜ todo
- `usePlanPublish` (publish + triage + recovery; pass plan data as args, returns
  `{publishPhase, ghStatus, handlePublish, launchTriage, handleRecover}`)
- `usePlannerPtyTerminal` (extract now that the tag loop is already its own hook)

**Phase 4 — the core:** partially done
- ✅ `usePlanGates` extracted.
- ⬜ Introduce `PlanningContext` holding `sections`/`signals`/`phases`/gates; migrate
  `usePlanFocusedPane` + remaining consumers to read from context.

**Phase 5 — optional JSX split:** ⬜ `PlanningHeader` + `PlanningPanels` sub-components (after logic
stabilizes; via context to avoid prop-drilling ~30 vars).

## Outcome

- **2,814 → 2,164 LOC** so far, with ~9 focused, testable hooks already extracted.
- Phases 3–4 (publish/pty + the `PlanningContext` boundary) are the bulk of the remaining reduction.
- Every step is independently shippable, green on typecheck/lint/test, and changes **no behavior**.

**Next PR candidates:** `usePlannerTitle` / `usePlanContextRequirements` (small, low-risk Phase 2
remainders), then `usePlanPublish` (largest single win).
