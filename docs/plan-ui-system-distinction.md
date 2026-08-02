# Plan — teaching the planner which projects use our data-driven UI

**Status:** slices 1–2 landed, as a PAIR of axes; 3–5 held. Tracked as epic #4115.

> **These axes are a security boundary, not a routing preference.** `studio` means our host takes the
> project's LLM-authored artifacts IN and runs them — the UI half rendered in a frame, the algorithm
> half compiled with `new Function` and executed. That is the same trust class the Design Studio's
> opaque-origin sandbox was chosen for (#2824); the Glance frame still passes `allow-same-origin` and
> leaves `parent.__TAURI_INTERNALS__` reachable (#3862, open), while stored `vizCode` is confined to a
> dedicated Web Worker with no DOM and no app state (#3233). So the pair answers *"does our process run
> this project's code at all?"* — isolate-before-render is owed exactly where the answer is `studio`.

- **1 · the axes — DONE.** One shared vocabulary `SystemSource = "studio" | "own"` (`SYSTEM_SOURCES`)
  behind **two** axes: `uiSystem` (who renders) and `algorithmSystem` (where the computation comes
  from, and whose `vizCode` we execute) — plus `uiSystemOf`/`rendersFromStudio`,
  `algorithmSystemOf`/`computesFromStudio`, and `hostRunsProjectArtifacts` (an OR over both — the
  isolate-before-render question). `src/features/planner/lib/classifyConfig.ts`, with the
  `SYSTEM_SOURCES` lockstep twin in `crates/plandb/src/validate.rs` and both echoed by
  `classify_readiness`. Unset reads as `studio` on both.
- **2 · the Discovery ask — DONE.** `src-tauri/data/stages/discovery.json` asks BOTH, separately and
  before `uiMode`, guarded by `discovery_asks_both_system_axes_and_separates_them_from_ui_mode`
  (`src-tauri/src/planner/directives.rs`).

**Why paired.** The two studios split the whole artifact surface, and the planner already routes on
exactly that line — *a component is UI (designer, `bsc ui`); an algorithm is computation (librarian,
`bsc graph impl`)*. Asking only about the UI would leave the **executed** half unstated, which is the
more dangerous half to be wrong about: it runs code rather than rendering it. They also differ often —
owning the UI while still drawing algorithms from the graph is a normal project — so a single combined
answer would be wrong for it in one direction or the other.
- **3–5 · held on purpose.** The UI-stage third surface, kit/fleet branching and downstream gating
  encode the host-API direction; per the issue they should not start until that is settled, or they
  bake in an answer still under discussion. **Nothing reads the axis yet** — that is the point of the
  hold, not an oversight.

## The problem

Everything the platform is building toward on the UI side — the component graph as the render source,
the `data`/`actions` host API, the build/publish split, per-node analytics and capability manifests —
**only applies to projects that render from our system.** A project that brings its own UI stack
(Material UI, shadcn, an existing React codebase) uses none of it.

The planner currently cannot express that. It will design a graph-rendered shell for a project that
will never render one, and the fleet will be told to build against a contract the project does not use.

### What exists today, and why it doesn't cover it

Two signals partially address the space, and neither answers the question:

| signal | what it decides | why it isn't this |
|---|---|---|
| `appType` | whether the project has screens at all — the UI stage **drops** for `api`, `serverless`, `cli`, `library`, `mcp-server` | handles *no UI*, not *someone else's UI* |
| `uiMode: "custom" \| "external"` | which **pane the UI stage shows**: the in-app designer preview vs. the drop-files intake | about where **designs come from**, not what **renders** them |
| blueprint `mode` | whether a built-in **auto-pins the packaged UI kit** | a blueprint-level default, not a per-project fact |

`uiMode` is the closest, and the trap is that it looks sufficient. But `external` still means *our*
pipeline ingests the user's design files and produces *our* shell. There is no value meaning "the
project owns its rendering."

The two axes are genuinely orthogonal:

|  | designs generated in-app | designs brought by the user |
|---|---|---|
| **renders from our graph** | today's `custom` | today's `external` |
| **project owns rendering** | *(no value)* | *(no value)* |

The bottom row is the common case for an existing codebase — which is also `lifecycle: "transform"`,
already the default for work on existing repos. So today the most frequent real-world project has no
way to opt out of a UI system it is not using.

### Current blast radius (measured)

`uiMode` has exactly **one** functional consumer:

- `src/features/planner/pane/FocusedBodies.tsx:99` — `PreviewPaneShell` vs `FileIntakePane`
- (plus `classifyConfig.ts` parsing and `crates/plandb/src/validate.rs` validation, kept in lockstep)

So the field is cheap to extend. The work is not the branch — it is deciding **what the answer should
newly gate**, none of which is wired today.

## The proposal

### 1 · A new classification axis, not a third `uiMode` value

`uiMode` is a **UI-stage concern** (which surface the stage shows). Rendering ownership is an
**architecture concern**, sibling to `appType`. Conflating them would make a genuine combination
inexpressible: generating designs in-app *and* emitting them as ordinary source files is a real thing
someone will want.

**Recommended:**

```ts
/** Who renders this project's UI at runtime. */
export type UiSystem =
  | "studio"   // our data-driven system: the component graph IS the render source
  | "own";     // the project brings/keeps its own UI stack; the graph does not render it
```

`uiMode` keeps its current meaning and becomes **only meaningful when `uiSystem === "studio"`**.

> **Decision point.** The alternative is a third `uiMode` value (`"owned"`). It is one less field, but
> it makes the two axes mutually exclusive and forecloses "generated in-app, emitted as source".
> Recommend the separate axis; flagging it because this becomes vocabulary everywhere.

### 2 · Defaults must be non-regressing

Every `ClassifyConfig` field is optional and each read site applies its own default, so an
unclassified project never loses a pane it previously had. Same discipline here:

- unset → read as `"studio"` (today's behaviour for every existing project)
- the field is additive; no migration, no backfill

### 3 · What Discovery asks, and when

This is a **field on an existing call** (`bsc plan classify set`, the closing step of Discovery), not
a new stage. The directive gains one rule:

> **Ask which UI system the project uses — never infer it silently.** A project that already has a UI
> is presumed to keep it: linked repos with an existing frontend ⇒ propose `own`. A greenfield pitch
> with no repo ⇒ propose `studio`. Either way state the proposal and get confirmation, because the
> answer changes what the entire UI track produces and it cannot be recovered later.

Inference rule of thumb, to propose (not to decide):

| situation | proposal |
|---|---|
| `lifecycle: greenfield`, no linked repo | `studio` |
| linked repo with a detectable UI framework | `own` |
| linked repo, no frontend yet (adding one) | ask — genuinely ambiguous |
| `appType` not UI-bearing | field is irrelevant; do not ask |

### 4 · What the answer gates

This is the actual content of the work, and it is where the value is. Each becomes a slice.

| consumer | `studio` | `own` |
|---|---|---|
| **UI stage surface** | `PreviewPaneShell` / `FileIntakePane` per `uiMode` | a third surface: *understand and document the existing UI* — inventory the components that exist, record conventions, no shell generation |
| **Kit pinning** | packaged kit auto-pinned | no kit pinned; blueprint `mode` must not override the project fact |
| **Worker context** | `bsc ui` guidance + the host-API contract inlined at fleet launch | ordinary file-based frontend work; no graph vocabulary |
| **Designer studio** | the project's UI surface | not applicable to this project |
| **Build/publish pipeline** | engages | does not engage |
| **Per-node analytics / capability manifests** (#3809) | inherited by composition | must be authored conventionally, if at all |

> The **library repo backup** (components · algorithms · blueprints · studio data types) is a
> **global user store** and is unaffected by any project's classification. It is a separate track.

## Slices

Tracked under epic #4115.

1. **The axis.** `UiSystem` type + `ClassifyConfig` field + `parseClassifyConfig` + the
   `validate_classify_config` twin in `crates/plandb/src/validate.rs` (they are documented as
   lockstep — an unknown token is rejected at `bsc plan classify set`, so the planner could otherwise
   write a value the app cannot read). Non-regressing default. Tests both sides.
2. **Discovery.** The directive + prompt in `src-tauri/data/stages/discovery.json`: the ask, the
   proposal rules, and "never infer silently". No new stage.
3. **The UI stage.** The third surface for `own` — inventory/document rather than generate.
4. **Fleet + kit.** Kit pinning and worker context branch on it; reconcile with blueprint `mode` so a
   blueprint default cannot override a project fact.
5. **Downstream gating.** Build/publish pipeline and the designer studio respect it.

Slices 1–2 are the distinction itself and are small. 3–5 are where the behaviour actually changes and
should not start until the host-API direction is settled, since they encode it.

## Open questions

- **Naming**: separate `uiSystem` axis (recommended) vs. a third `uiMode` value.
- **Is `own` one state or several?** "Existing React codebase we extend" and "user picked shadcn for a
  greenfield build" behave differently for the fleet, though both are "not our graph". Recommend
  starting with one state and splitting only if a consumer genuinely needs it.
- **Detection**: should linking a repo *auto-detect* an existing UI framework to seed the proposal?
  Useful, but it is a scan with false positives; the planner asking is safe either way.
