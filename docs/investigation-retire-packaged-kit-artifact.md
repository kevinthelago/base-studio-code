# Investigation — retiring `react-ui.json` and the DB-driven UI

Answer to the kickoff in `docs/kickoff-retire-packaged-kit-artifact.md`.
Epic: **#3856**. Slices: **#3857 · #3858 · #3859 · #3860 · #3861**. Filed separately: **#3862**.

Every number below came from a script in this document. Nothing was carried over from the kickoff on trust.

---

## 1 · The finding that reframes the task

The kickoff describes three representations of the app's UI. There are **two**, and one has already won.

`src-tauri/data/components/react-ui.json` is **no longer a seed**. #3543 wiped the packaged kit to a single
empty `base-studio-code` kit; `seed.ts` now globs the 92 page records under `data/components/app/**`. The
artifact's only remaining architectural job is answering *"where does a graph component's `@/…` import
resolve?"* — and the **platform registry** (`app/runtime/appModules.ts` plus the per-feature
`graphPlatform.ts` registrars, #3605) answers it better, for zero shipped bytes.

| | Artifact | Platform registry |
|---|---|---|
| Packaged page records fully resolved | **75 / 92** | **87 / 92** |
| Shipped bytes | 5,115,623 | 0 (live modules) |
| Distinct specifiers offered | 739 modules | 149 specifiers |

The artifact loses at the job it is being kept for. It was never aimed at that job: `collectRuntime` seeds
its walk from the **68 manifest components**, never from the page records, so any coverage of them is a
side effect.

---

## 2 · Why it is 5 MB — one edge

Reproducing the kickoff's BFS against the real resolver confirmed it exactly:

- closure today: **739 modules / 4,429,261 B**
- closure with `store/index.ts` severed: **31 modules / 130,082 B** (**−97.1 %**)
- the entire bulk hangs off one three-hop chain:
  `shared/ui/layouts/GraphCanvas.tsx` → `shared/lib/core/renderProfiler.tsx` → `store/index.ts`

Narrowing it further: `renderProfiler.tsx` is **1,490 bytes**, has **one** call site
(`GraphCanvas.tsx:102`), and is the **only** `@/store` importer among the 68 components and the 31-module
minimal closure. It touches the store for one expression, inside a callback:

```tsx
const cfg = useAppStore.getState().perfConfig;   // inside <Profiler onRender>
```

### This is a correctness bug, not a size nit

`bsc ui emit` vendors kit source into a **generated user app**, walking the same closure:

```
emit graphcanvas   NOW 796 files / 4,618,256 B   AFTER-CUT  17 files / 59,902 B
emit tree          NOW 796 files / 4,618,256 B   AFTER-CUT  25 files / 93,095 B
emit networkpage   NOW 796 files / 4,618,256 B   AFTER-CUT  27 files / 90,875 B
emit card          NOW   6 files /    14,206 B   AFTER-CUT   6 files / 14,206 B
```

Emitting a graph canvas today writes base-studio-code's Zustand store composition and 240
`features/planner` modules into someone else's application. It cannot compile there. Emit is silently
broken for those three components right now, and the fix is the same one edge.

---

## 3 · The five questions

### 1 · Retirable, or only shrinkable?

**Both — but not as posed.** Not "shrink this artifact *and* retire it". The sequence is: fix the one
import (a correctness fix that happens to shrink it 97 %), retire the artifact from the app's own UI path
(the registry already replaced it), and keep a small pinnable kit for the one consumer that genuinely
needs bytes.

### 2 · What replaces the preview's source supply?

**Nothing — the question dissolves.** `componentLoader.ts` states the split in its own header: the preview
**ISOLATES** (sandboxed iframe, opaque origin, `@/` first-party imports forbidden, npm via the import map);
the runtime loader **CONNECTS** (imports stay external, resolved to the app's live modules).

The app's own pages read live state. Inside an isolating sandbox there is no store, no session, no Tauri —
so a "successful" sandbox build of `fleetpage` renders something that is not the page. Previewing app
pages there is a category error #3604 already corrected for real rendering: Fleet, Settings, Skills,
Security, MCP, GitHub and Automations render from the graph through `GraphComponent` today.

Third-party, harvested and cloud-pulled components (#3301) are self-contained by construction — bare npm
specifiers through the preview import-map — and never needed the artifact. So nothing has to replace it.

### 3 · What does "behaviours and features in the database" mean?

- **presentation** — already data (component records)
- **motion / interaction** — already data (#2865)
- **behaviour** — graph `srcText`, compiled at runtime by `componentLoader` (#3604 / #3605)
- **features** — the undefined term. The honest definition is **the platform registry's 149 specifiers**:
  a feature is in the database when the graph can import it.

That definition yields a real boundary instead of a slogan. It also exposes the floor: an irreducible
**platform kernel** — React, the store, Tauri IPC, the registry itself — stays code. "Entirely DB-driven"
is not achievable and should not be the target. **One** representation of the UI plus a documented kernel
is. #3858 turns that boundary into a guarded invariant.

### 4 · Role of the algorithms graph?

**None here.** The kickoff's warning holds: the bulk is one `renderProfiler → store` edge, measured. The
algorithms graph may be right for behaviour on its own merits, but it is not the fix for artifact size and
must not be sequenced against it.

### 5 · What happens to the Rust bundle-import path?

`bsc-component/src/cli.rs` explodes `{"components":[…]}` bundles on import. That shape is the
**kit-transport format** #3301 depends on and it **survives** — it is independent of whether this
particular artifact ships.

What does not survive is `graph_health.rs:295` embedding all 5.12 MB via `include_str!` to use it as a
**roster of ~800 path strings** (`artifact_buildable_srcs` → component `src`s; `artifact_runtime_paths` →
`runtime` keys). Not one byte of vendored source is read. That is #3860.

---

## 4 · Consumer disposition

| Consumer | Reads | Disposition |
|---|---|---|
| `ComponentPreviewFrame.tsx:9` | `source` + `runtime` | Removed — #3859 |
| `lib/useComponentScan.ts:12` | `source` + `runtime` | Removed — #3859 |
| `lib/graphHealth.ts:31` | roster + `componentPreviewFiles` | Switched to registry + siblings — #3859 |
| `lib/componentPreview.ts` | files for every build | Third-party path unchanged; app-graph path removed — #3859 |
| `blueprints/uiKitPin.ts` | the **meta sidecar** only | Kept — never read the artifact itself |
| `bsc-component/graph_health.rs:295` | ~800 path strings | Roster sidecar — #3860 |
| `bsc-ui/kit.rs:37` · `emit.rs:58` | the real bytes | **Kept** — the one honest consumer, #3861 |
| `reactUiKit.gen.test.ts` | generator + drift guard | Kept, extended |

---

## 5 · Constraints

| # | Constraint | Disposition |
|---|---|---|
| 1 | Preview sandbox (opaque origin, #2824) | **Untouched.** No slice widens it. See §6. |
| 2 | Determinism | **Preserved** for the emit kit. Explicitly **dropped** for app-page preview — those render live, which is the point (#3844). |
| 3 | Release identity / pinning | **Preserved.** Bump to `1.0.1` — `kit.rs` documents versions as immutable, so re-hashing `1.0.0` in place would violate its own contract. |
| 4 | Drift guard | **Preserved** for the kit and **extended**: #3858 adds the equivalent guard for the app-UI side, which never had one. |
| 5 | Distributability | **Preserved and improved.** A ~0.45 MB kit distributes better than a 5.12 MB one; the bundle-import shape is unchanged. |

---

## 6 · Separate finding — the Glance preview frame (#3862)

The kickoff asked this be checked independently. **It is a real exposure, present today.**

`features/glance/GlancePreviewMorph.tsx:122` renders the user's generated application with
`sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`. `previewSource.ts` maps two kinds
into that frame:

- `kind: "bundle"` → **`srcDoc`**. With `allow-same-origin`, a `srcdoc` frame inherits the **host
  document's origin** — same-origin with the Tauri WebView.
- `kind: "web"` → `src` = a localhost URL, a different origin; `parent.*` is blocked. Lower severity.

`tauri.conf.json` sets `withGlobalTauri: false`, removing `window.__TAURI__` — but **not**
`__TAURI_INTERNALS__`, which is exactly how the app's own `isTauri()` detects Tauri
(`shared/lib/core/storage.ts:7`). So generated-app code in that frame reaches `parent.__TAURI_INTERNALS__`
and the IPC surface behind it. This is the exposure #2824 reasoned about and rejected for the Design
Studio; the decision was never carried to the Glance frame.

`features/planner/preview/PreviewFrame.tsx:33` is `allow-scripts` only and is fine.

---

## 7 · Migration order

```
#3857  sever renderProfiler → @/store          ── independent, unblocks 4 and 5
   │
   ├── #3858  guard the platform-kernel boundary (5 records broken today)
   │      └── #3859  drop the artifact from the Design Studio preview path
   │
   └── #3860  Rust: embed a path roster, not the artifact
              └── #3861  re-home as the emit-only distribution kit   (also needs #3859)

#3862  Glance preview sandbox — independent, unrelated to the epic
```

`#3857` first because it is self-contained, is a correctness fix regardless of the rest, and shrinks the
artifact 97 % on its own. `#3858` before `#3859` because the registry must be *provably* complete before
the artifact stops backstopping it. `#3861` last because it can only assert sole-consumer status once the
others have landed.

---

## 8 · Reproducing

Scripts run from the repo root. They mirror `collectRuntime` / `resolveImport` in
`src/features/designs/lib/reactUiKit.gen.test.ts` — read that first if a number looks wrong.

**Closure size, and the effect of severing one module.** BFS from the 68 component `src` paths, following
first-party `@/…` and relative specifiers through TS module-resolution order, skipping paths that are
themselves kit components:

```
BASELINE                                     modules=739  bytes=4,429,261
CUT store/index.ts                           modules=31   bytes=  130,082
CUT shared/lib/core/renderProfiler.tsx       modules=27   bytes=  117,932
```

**Who imports the store.** Across the components plus the 31-module minimal closure, exactly one importer:
`shared/lib/core/renderProfiler.tsx`. (The 96 importers visible in the *full* closure are all modules that
`store/index.ts` itself dragged in.)

**Page-record resolution.** Extract first-party specifiers from each packaged record's `srcText` and
resolve against each candidate universe:

- artifact today → 54 unresolved occurrences / 43 distinct, across **17 records**
- artifact with the store edge cut → 211 / 106, across **46 records**
- platform registry, static `PLATFORM` map only → **39 records** unresolved
- platform registry **including** the per-feature registrars → **5 records**, 3 distinct specifiers:
  `@/shared/lib/fleet/fleetLive` (3×), `@/shared/lib/github/types` (2×), `@/shared/lib/github/fleetGithub` (1×)

The static-map-only figure is a trap worth recording: counting `PLATFORM` alone understates registry
coverage by 48 records. Any guard written for #3858 must union in every `registerAppModule(…)` call site.

**Emit closure.** Walk from a component's `src` over `{component sources} ∪ {runtime}` as `emit.rs` does —
the table in §2.

> Two gotchas. Read the artifact as **UTF-8 explicitly** on Windows (the default cp1252 codec dies at byte
> 0x90). And the artifact drifts: the kickoff measured 735 runtime modules, this pass measured 739 — the
> shape of the finding is stable, the exact count is not.
