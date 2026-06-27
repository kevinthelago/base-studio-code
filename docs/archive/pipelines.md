# Archived: Blueprint pipelines + pipeline runtime

The dead blueprint stage-pipeline mechanism + its runtime (handler registry, gates, triggers, builtins), replaced by skills + MCP servers. The UI renderer / render-preview path was deliberately KEPT.

Deleted from GitHub; full content below. Machine-readable mirror: `pipelines.jsonl`.

**Issues (8):** #514, #528, #529, #532, #533, #534, #626, #717

---

## #514 — Blueprint stage pipelines: pluggable actions bound to each planning stage (preview, custom integrations)

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, scope:core, stream:planner-platform
- **created:** 2026-06-04T22:33:53Z · **closed:** 2026-06-05T18:58:30Z

> Sub-feature of #512. Adds a **pluggable action layer** to the modular planning stages: each stage in a blueprint can have **pipelines** attached that interact with that stage's data/output — render a preview, transform artifacts, or integrate custom/external solutions.

## Concept
A **stage pipeline** is a triggerable processor bound to a blueprint stage. When the stage produces or updates its artifacts (or on an explicit trigger), its bound pipelines run and do something with the stage's output. This makes the planning stages **extensible**: the stage defines *what* the user plans; pipelines define *what happens with it*.

Examples:
- **UI stage → "render preview"** pipeline — drives the 2D/3D live preview (#510). The preview is the **first, built-in** pipeline.
- **Custom integration** pipelines — push tokens to/from Figma, run a plan linter, export the plan, call an external service, or invoke a user-supplied / MCP-backed tool (#33/#174).

## Model
- **Binding:** each stage declares zero+ pipelines (configured in the blueprint, per #513 — so pipelines are part of the same modular, toggleable config).
- **Triggers:** stage-enter, artifact-change (file-watch / tag emit like `<ui_preview>`), stage-completion, and manual ("run").
- **Pipeline interface:** a small, stable contract — `{ id, label, stageId, trigger, run(stageContext) }` — so built-in and third-party pipelines are uniform. `stageContext` exposes the stage's artifacts (files, plan data) read-only plus a way to surface output (e.g. a preview pane, a status, a written artifact).
- **Built-in pipelines:** UI preview (2D/3D). Candidates: plan export, docs/Figma sync, plan lint.
- **Custom/extensible:** pipelines can be backed by a shell command, an MCP tool (#33/#174), or an in-app handler — so users integrate their own solutions without forking.

## Distinct from #220
#220 "Pipelines" = **execution** pipelines (a conductor sequencing build→test→review→integrate for the fleet). These are **planning-stage** pipelines (act on a blueprint stage's output during planning). Different layer; we should name them clearly to avoid confusion (e.g. "stage pipelines" vs "execution pipelines"), and consider whether the trigger/handler contract can be shared later.

## Acceptance criteria
- [ ] A stage in a blueprint can have pipelines attached/detached (configured per #513, toggleable like everything else).
- [ ] Pipeline interface + trigger types (stage-enter / artifact-change / completion / manual) implemented.
- [ ] The **UI preview** pipeline is implemented as the first built-in, bound to the UI stage (delivers #510's preview through this mechanism).
- [ ] At least one **custom-integration** path proven (shell- or MCP-backed pipeline) end to end.
- [ ] Pipelines run sandboxed/safely and surface status + errors in the UI.
- [ ] Tests: pipeline binding + trigger dispatch (pure), and the UI-preview pipeline firing on its trigger.

## Dependencies / related
Needs #512 (stage registry) + #513 (Blueprints config surface — where pipelines are attached). #510 (UI preview) becomes the first pipeline. Custom integrations relate to #33 / #174 (MCP/extensions). Distinguish from #220 (execution pipelines).

### Comments

**kevinthelago** (2026-06-05T18:58:29Z):

Landed via PR #556 (planner-platform: stage registry, Blueprints, header cleanup).

---

## #528 — [Epic] Pipeline runtime — execute stage pipelines, render-preview into the planning page

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, scope:core, P1, stream:pipeline-ui
- **created:** 2026-06-05T02:49:57Z · **closed:** 2026-06-05T19:17:17Z

> The runtime for the stage pipelines configured in the Blueprints tab (#513/#514). Pipelines are the action layer that turns each planning stage's text output into real behavior — render, transform, gate, publish, integrate. This is what makes project planning *do things*, not just write markdown.

## Concept
A pipeline is a **handler bound to a stage**, **fired by a trigger**, that **reads the stage's artifacts** and acts on them. Configured per-stage in a blueprint (#513): `{ id, name, kind, trigger, enabled }`.

## Locked decisions
- **Triggers: hybrid** — each pipeline declares one of `on section enter` / `on artifact change` (debounced file-watch) / `on completion` / `manual`, and the engine also accepts explicit planner tags. (render-preview = artifact-watch for liveness + a tag to set the active target; generate-issues = on completion; lint-plan = gate.)
- **Render path: esbuild-to-iframe** — bundle session-generated code with esbuild (multi-file, real imports incl. three/r3f) and inject into a **sandboxed iframe** (own origin/CSP). Never runs in the host process.
- **Preview placement: a third pane** — the planning page gains a third pane (`[ Claude terminal | plan visualizer | preview ]`) for the rendered output; it appears at the UI stage.
- **Gates allowed** — a pipeline may **block its stage from completing** until it passes (integrates with the #512 stage `gate`/`stageStatus`), not just side-effects.

## Handler kinds (uniform contract)
`run(stageContext) -> { status: "ok" | "fail" | "blocked", output? }`, where `stageContext` exposes the stage's artifacts (read-only), the project key, and a way to surface output (a pane, a file, a status).
- **builtin** — in-app TS (render-preview, generate-issues, lint-plan, scope-streams).
- **external** — MCP tool / webhook (push-figma, export-notion) via #33/#174.
- **custom** — user shell command, run in a sandboxed session.

## How pipelines dictate planning behavior
- **Deliverable**: render a UI preview, generate issues, export docs.
- **Gate**: a stage stays incomplete until its gating pipeline passes (e.g. lint-plan finds no gaps).
- **Feedback**: a pipeline's output (preview screenshot, lint findings) can re-enter the planner's context so it self-corrects.

## Flagship: render a mock UI into the planning page (folds in #510)
1. UI stage → the planner writes a lightweight, **functionless** UI skeleton (host React) into `projects/<key>/.ui-skeleton/<screen>/`.
2. Trigger → `<ui_preview screen="login" mode="2d|3d" />` (sets active target) + debounced watch on the skeleton folder.
3. render-preview pipeline → **esbuild** bundles the skeleton → injects into the **sandboxed iframe** in the **third preview pane**.
4. Harnesses → 2D = DOM root (optional device frame); 3D = react-three-fiber `<Canvas>` (loads any glTF the planner dropped in). Same transport, mode-selected harness.
5. The approved skeleton becomes the contract downstream workers translate.

## Sub-issues
- **(1) Pipeline runtime engine** — handler registry, the `run(stageContext)` contract, trigger dispatch (enter/watch/completion/manual + tag), per-project pipeline run state. Pure-ish core, unit-tested.
- **(2) esbuild→sandboxed-iframe transport** — bundle a skeleton folder, serve into an isolated iframe; error surfacing; the third preview pane shell in the planning page.
- **(3) render-preview builtin + 2D/3D harnesses** — the flagship pipeline; `<ui_preview>` tag + `.ui-skeleton/` watch; DOM + r3f Canvas harnesses (folds in #510).
- **(4) Gate integration (#512)** — let a pipeline block stage completion; surface gate status in the N-bar + Blueprints editor.
- **(5) Tag + manual + watch wiring** — the trigger sources end to end; manual "run" + status in the Blueprints stage rows.
- **(6) A second builtin (generate-issues or lint-plan)** — proves the non-render path + the gate path.

## Related
Runtime for #514 (config). Folds in #510 (UI preview = first pipeline). Gates integrate with #512 (modular stages). Configured via #513 (Blueprints tab). Custom/external handlers relate to #33/#174 (MCP/extensions).

### Comments

**kevinthelago** (2026-06-05T19:17:16Z):

Closed: all sub-issues (#529 #530 #531 #532 #533 #534) merged to develop.

---

## #529 — Pipeline runtime engine: handler registry + trigger dispatch + gate state (#528)

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, scope:core, stream:pipeline-ui
- **created:** 2026-06-05T02:50:36Z · **closed:** 2026-06-05T19:16:35Z

Sub-issue 1 of #528. The core engine: a handler registry (builtin/external/custom), the uniform `run(stageContext) -> { status, output? }` contract, trigger dispatch (on section enter / on artifact change (debounced) / on completion / manual + explicit planner tag), and per-project pipeline run state (status, last-run, error). Pure-ish + unit-tested. No rendering yet. Part of #528.

### Comments

**kevinthelago** (2026-06-05T19:16:34Z):

Closed: implementation merged to develop.

---

## #532 — Pipeline gates: let a pipeline block stage completion (#528)

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, scope:core, stream:pipeline-ui
- **created:** 2026-06-05T02:50:39Z · **closed:** 2026-06-05T19:16:30Z

Sub-issue 4 of #528. Allow a pipeline to gate its stage: the stage stays incomplete until the pipeline passes (e.g. lint-plan). Integrate with the #512 stage gate/stageStatus and surface gate status in the N-bar + Blueprints stage rows. Part of #528.

### Comments

**kevinthelago** (2026-06-05T19:16:29Z):

Closed: implementation merged to develop.

---

## #533 — Pipeline triggers wiring: tag + file-watch + manual run (#528)

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, scope:core, stream:pipeline-ui
- **created:** 2026-06-05T02:50:40Z · **closed:** 2026-06-05T19:16:28Z

Sub-issue 5 of #528. Wire the three trigger sources end to end: explicit planner tag (`<ui_preview>`/`<pipeline>`), debounced file-watch on the stage's artifacts, and a manual 'run' from the Blueprints stage rows — with live run status. Part of #528.

### Comments

**kevinthelago** (2026-06-05T19:16:27Z):

Closed: implementation merged to develop.

---

## #534 — Second builtin pipeline: generate-issues or lint-plan (#528)

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, scope:core, stream:pipeline-ui
- **created:** 2026-06-05T02:50:42Z · **closed:** 2026-06-05T19:16:26Z

Sub-issue 6 of #528. Implement a non-render builtin to prove the engine beyond preview: generate-issues (structure stage, on completion → GitHub issues) and/or lint-plan (any stage, gate → blocks completion until the stage's output has no gaps). Part of #528.

### Comments

**kevinthelago** (2026-06-05T19:16:25Z):

Closed: implementation merged to develop.

---

## #626 — feat(refactor): scan-dead-code pipeline + scan command (slice a)

- **state:** CLOSED (COMPLETED) · **labels:** feature, scope:core
- **created:** 2026-06-09T07:08:40Z · **closed:** 2026-06-09T20:50:15Z

First slice of the Refactor & Cleanup blueprint: a Tauri scan command that runs an allowlisted dead-code/unused-deps tool (depcheck, ts-prune, cargo-machete) in a repo and returns its raw output, plus pure parsers that turn that output into structured DeadCodeFindings, and a scan-dead-code pipeline. Agent verification + the blueprint + fleet execution are later slices.

---


## #717 — Extensions: sandboxed code-bearing pipelines (esbuild-wasm iframe / web worker)

- **state:** CLOSED (COMPLETED) · **labels:** feature, scope:core
- **created:** 2026-06-11T15:20:35Z · **closed:** 2026-06-11T17:01:34Z

## Acceptance criteria
- [ ] A gist holds a manifest + a pre-bundled single-file JS/WASM; capability vocabulary (read-signals / write-files / render / network) + install consent
- [ ] Visual/codegen pipelines run in the render-preview esbuild-wasm + sandboxed-iframe path; non-visual code runs in a Web Worker sandbox
- [ ] Code is never run unsandboxed; capabilities are declared + user-approved; integrity-pinned
- [ ] Heavy/dep-laden pipelines point to a tier-3 (MCP/webhook) target instead of bundling
- [ ] Tests: capability gating + sandbox isolation

## Owned paths
- `src/lib/extensions/pipelines/**`

## Depends on
- **EX-gist** — Extensions: GitHub Gist publish/install + integrity pin

---
stream: extensions

### Comments

**kevinthelago** (2026-06-11T17:01:33Z):

Work already landed on develop (src/lib/extensions/sandbox.ts present on develop). Closing as done.

---
