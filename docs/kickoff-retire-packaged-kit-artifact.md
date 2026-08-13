# Kickoff — retire `react-ui.json` and move to an entirely DB-driven UI

**Session role:** investigation → written plan. **Do not write implementation code in this session.**
The deliverable is an epic + sliced issues with a defensible migration order, or a documented
recommendation *against* parts of it.

---

## The goal

Get to a UI that is **entirely in-app / database-driven** — presentation *and* behaviour/features —
and retire the packaged `react-ui.json` artifact along with whatever else rides that bridge. Today
the app has three separate representations of its own UI; the end state should have one.

## What exists today (VERIFIED — do not re-derive)

Three layers, commonly confused:

| # | Thing | What it is |
|---|---|---|
| 1 | `src-tauri/data/components/react-ui.json` | A **generated, committed 4.9 MB artifact**: 68 kit components with **verbatim `source`** + a 735-module `runtime` closure. Regenerated with `UPDATE_KITS=1 npx vitest run reactUiKit.gen`. Hash sidecar at `src-tauri/data/ui/react-ui-kit.meta.json`. |
| 2 | `src-tauri/data/components/app/**/*.json` | The **seed** — packaged page records (`skillspage`, `fleetpage`, …) globbed into `SEED_COMPONENTS`. What `hydrateComponents` reconciles the store toward. |
| 3 | `~/.base-studio-code/components.db` | The **active datastore**. What `bsc ui set` writes and what the running app renders pages from. |

**Measured facts about layer 1** (re-runnable; the numbers are from a BFS over the same import
resolution `collectRuntime` uses):

- closure today: **735 modules / 4.27 MB**
- closure with the single edge `store/index.ts` severed: **31 modules / 0.13 MB** (**−97%**)
- the entire bulk traces to ONE three-hop chain:
  `shared/ui/layouts/GraphCanvas.tsx` → `shared/lib/core/renderProfiler.tsx` → `store/index.ts`
  (which composes every feature slice, dragging in 240 `features/planner` modules)
- **`src/shared/ui/**` contains ZERO direct imports of `@/store` or `@/features/*`.** The coupling is
  transitive and singular.

> ⚠️ A prior session asserted the bulk came from primitives reaching into app state, and that moving
> behaviour to the algorithms graph would fix it. **That was wrong** — measured, not true. Treat every
> causal claim in this document as requiring the same check before you build on it.

### Everything that rides the bridge (VERIFIED consumer list)

Frontend:
- `features/designs/ComponentPreviewFrame.tsx` — imports the artifact directly (keeps `source`)
- `features/designs/lib/useComponentScan.ts` — the preview scan
- `features/designs/lib/componentPreview.ts` — consumes the `source` + `runtime` the artifact carries
- `features/designs/lib/graphHealth.ts` — references `react-ui.json`
- `features/planner/blueprints/uiKitPin.ts` — reads the **meta sidecar** for the default kit pin on new blueprints
- `features/designs/lib/seed.ts` — notes the artifact is still consumed by the released-kit store

Rust:
- `crates/bsc-component/src/cli.rs` — treats a kit BUNDLE (`{"components":[…]}`) as a first-class
  import shape that is *exploded* into individual records; `react-ui.json` is the named example.
  The packaged kit is also embedded as the store's fallback entry.

Generator + guard:
- `src/features/designs/lib/reactUiKit.gen.test.ts` — IS the generator (`UPDATE_KITS=1`) and the drift
  test. It embeds each component's verbatim source and the transitive support closure.

## Constraints that must survive the migration

Establish how each is preserved (or make the case for dropping it) — do not silently lose them:

1. **The preview sandbox.** `ComponentPreviewFrame` renders with `sandbox="allow-scripts"` and **no**
   `allow-same-origin` — an opaque origin, deliberately (#2824). This is load-bearing: previewed
   components are LLM-authored, `bsc ui harvest`-ed from arbitrary repos, and (per epic **#3301**)
   will be **pulled from other users' cloud libraries**. `withGlobalTauri: false` removes `__TAURI__`
   but **not** `__TAURI_INTERNALS__` — the app's own `isTauri()` (`shared/lib/core/storage.ts`)
   detects Tauri by that key — so a same-origin preview frame reaches `parent.__TAURI_INTERNALS__`
   and with it `pty_create`, the filesystem, every `bsc` store, the GitHub token in app state, and
   (post-#3146) keychain secrets. **Dropping the sandbox was considered and rejected.**
   - *Related finding to check independently:* `features/glance/GlancePreviewMorph.tsx:122` already
     runs `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`. If that frame ever
     renders graph- or LLM-authored content, this exposure exists **today**.
2. **Determinism.** The artifact is committed + hash-pinned, so a preview renders identically on
   every machine and build. A DB-driven preview is per-install mutable — say how reproducibility is
   preserved, or accept and document the loss.
3. **Release identity / pinning.** Blueprints pin `bsc/react-ui@1.0.0` by sha256 via the sidecar
   (`uiKitPin.ts`). A pin must resolve to exact bytes. Mutable DB rows cannot be pinned as-is.
4. **The drift guard.** The gen test proves the shipped kit matches the source it claims to be. It
   caught a real drift this week. Whatever replaces it needs an equivalent integrity check.
5. **Distributability.** The artifact is self-contained and shippable (gist/release). #3301 depends
   on components being transportable between installs.

## The questions this session must answer

1. **Is the artifact retirable at all, or only shrinkable?** The 97% measurement says the *symptom*
   is fixable by cutting one edge. Decide whether the goal is (a) shrink + keep, (b) retire and
   replace the five constraints above with DB-backed equivalents, or (c) both, sequenced.
2. **What replaces the preview's source supply?** The sandbox means something must ship
   implementations *into* the frame. If not a packaged artifact, then what — a DB-served bundle
   built on demand? Where does it get verbatim source, given the store's `builtinKits.withoutSource`
   deliberately strips it?
3. **What does "behaviours and features in the database" actually mean here?** Distinguish:
   presentation (already data), **motion/interaction** (already data, #2865), **behaviour** (today
   compiled from graph `srcText` at runtime — epic #3604), and **features** (undefined — define it).
   Epic #3604 already loads pages from the graph at runtime; state the relationship rather than
   duplicating it.
4. **What is the role of the algorithms graph?** It may be right for behaviour on its own merits —
   but it is **not** the fix for the artifact size. Do not couple the two without evidence.
5. **What happens to the Rust bundle-import path?** `bsc-component` treats kit bundles as a
   first-class import shape. Retiring the artifact may or may not retire that.

## Method — required

- **Measure before asserting.** Every causal claim gets a command behind it. The one-edge finding
  above came from a BFS over the real resolver; reproduce it rather than trusting this document.
- **Check the store, not just the repo.** `bsc ui get/list/log` read the live datastore; the repo
  seed and the DB routinely disagree (see #3833 — a page record diverged from its seed for days).
- **No live-store writes in this session.** Investigation only.

## Deliverable

An epic issue + dependency-ordered slices, each with: the constraint it preserves, its measurement,
and its rollback. Where the answer is "don't" — say so with the number behind it.

## Context issues

- **#3844** — epic: live component source (store is truth, no stale mirror, no blank page)
- **#3846** — targeted refresh + boot-only seed convergence *(committed, unpushed, on `3846-live-page-source`)*
- **#3833** — the `skillspage` seed/store divergence that started this
- **#3604** — epic: load pages from the graph at runtime
- **#3301** — epic: cloud-shared component libraries (the reason the sandbox matters)
- **#2865** / **#2954** / **#2798** / **#2824** — motion-as-data · preview closure · the `runtime` bundle · the sandbox decision
