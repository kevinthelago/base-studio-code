# Spec — Split `extensions` into MCP servers + Hooks

**Status:** ✅ implemented · **Author:** refactor planning · **Scope:** frontend (TS/React/Zustand); backend wire format unchanged.

## As-built notes
Delivered as one branch. Deltas from the proposal:
- **Model:** `lib/mcpServers.ts` + `lib/hooks.ts` + `lib/sessionConfig.ts`; catalogs `data/mcpCatalog.ts` (holds the shared `CatalogItem` + `SCOPE_COPY`) + `data/hookCatalog.ts`. The hook command field was renamed `hookCommand` → `command` (no longer namespaced against the MCP `command`).
- **Store:** `mcpServers[]` + `hooks[]` with paired actions; transient `paneMcpServers`/`paneHooks`. Migration lives in `lib/migrateExtensions.ts` (`migrateLegacyExtensions`, called from `onRehydrateStorage`) — splits the persisted `extensions` list by `kind`, maps `hookCommand`→`command`, and renames the persisted `activeScreen` `"extensions"`→`"mcp"`. Covered by `migrateExtensions.test.ts`.
- **Screens:** `src/screens/mcp/` — `index.tsx` exports `McpScreen` (Rail page, keeps all install/version/analytics machinery) + `HooksView` (embedded in Automations, no install machinery); `shared.tsx` holds the common chrome (`scopeChips`, `ToggleSwitch`, `ProjectAssignment`, `EnvEditor`, `InstalledRow`, `CatalogCard`, `DrawerSlideOver`, `useGhProjects`). No `kind` discriminant on the data — each component is typed to its own model.
- **Route key** `extensions` → `mcp` (`App.tsx`, `Rail.tsx`, `usePageTabs` key now matches the convention).
- **`lib/extensions/` → `lib/gist/`** (the blueprint-share `gist.ts` + `manifest.ts`; unrelated to MCP/hooks). The internal `ExtensionManifest`/`wrapExtension` symbols were left as-is — they model a *blueprint shared as an installable extension*, a distinct concept.
- Deleted: `lib/extensions.ts`, `data/extensions.ts`, `extensionsLib.test.ts`, `src/screens/extensions/`.
- **Result:** typecheck clean, 2291 tests pass, 0 lint errors.

---


## 1. Goal

Dissolve the unified "extension" abstraction into **two independent features — MCP servers and Hooks** — each with its own model, store slice, catalog, and screen, and retire the legacy `extensions` vocabulary.

The legacy core is the discriminated union `ExtensionDef { kind: "mcp" | "hook" }` (`lib/extensions.ts`): a single type carrying *both* MCP fields (`transport`/`command`/`args`/`url`) and hook fields (`event`/`matcher`/`hookCommand`), with every consumer branching on `kind`. MCP servers and lifecycle hooks share almost nothing semantically; the union forces `if (kind === …)` guards through the model, the store, and the screen.

## 2. Current state — already split vs. still unified

The UI slice (#865) got partway there. **Already separate — leave as-is:**

- **Telemetry/analytics:** `lib/mcpTelemetry.ts` / `lib/hookTelemetry.ts`; `screens/extensions/McpAnalytics.tsx` / `screens/automations/HookAnalytics.tsx`.
- **UI surfaces:** MCP = Rail page (route `extensions`, labelled "MCP"); Hooks = embedded in Automations (`screens/automations/index.tsx` → `<ExtensionsScreen kind="hook" embedded />`).
- **Backend wire format:** `.mcp.json` (servers) and `.claude/settings.json` (hooks) are already written from two separate payload lists by `ensure_session_settings`.

**Still unified — the target of this refactor:**

| Layer | Today | After |
|---|---|---|
| Model | `lib/extensions.ts` — `ExtensionDef{kind}` + merged fields, `resolveExtensions`, `toMcpPayload`/`toHookPayload`, `toSessionPayloads`, `defFromCatalog`, `blankExtension`, `CATALOG_TEMPLATES` | `lib/mcpServers.ts` + `lib/hooks.ts` |
| Catalog | `data/extensions.ts` — `EXT_CATALOG` (mixed) + `SCOPE_COPY` | `data/mcpCatalog.ts` + `data/hookCatalog.ts` |
| Store | one `extensions: ExtensionDef[]` + `addExtension`/`updateExtension`/`removeExtension`/`toggleExtension`/`setExtensionProjects`; `paneExtensions` | `mcpServers[]` + `hooks[]` with paired actions |
| Screen | one `ExtensionsScreen` parameterized by `kind`, with MCP-only install/version logic interleaved behind `if (kind !== "mcp")` guards | `screens/mcp/` page + `HooksView` (Automations) |
| Naming | route key `"extensions"`, `screens/extensions/`, `data/extensions.ts`, `lib/extensions.ts` | `mcp` / `hooks` throughout |

> **Not in scope / not related:** `lib/extensions/` (the *directory* — `manifest.ts` + `gist.ts`) is the **blueprint-sharing** manifest, not MCP/hooks. It only shares the unfortunate name. See Open Decision 2.

## 3. Target architecture

Two parallel, self-contained features that meet only at the config-writer:

```
lib/mcpServers.ts     McpServer, resolveMcpServers, toMcpPayload, mcpFromCatalog, blankMcpServer, MCP_CATALOG_TEMPLATES
lib/hooks.ts          Hook,      resolveHooks,      toHookPayload, hookFromCatalog, blankHook,      HOOK_CATALOG_TEMPLATES
lib/sessionConfig.ts  toSessionPayloads(mcpServers, hooks, projectId) -> { mcp, hooks }   (thin combiner)
```

```
McpServer { id, name, enabled, projects, transport, command?, args?, url?, env }
Hook      { id, name, enabled, projects, event, matcher?, command, env? }
```

No `kind` field. `toMcpPayload`/`toHookPayload` drop their `kind` guard (they already validate the rest).

## 4. The split, layer by layer

1. **Model** — `lib/extensions.ts` → `lib/mcpServers.ts` + `lib/hooks.ts`. Move `toSessionPayloads` to `lib/sessionConfig.ts` (now takes both lists). Split `defFromCatalog`/`blankExtension`/`CATALOG_TEMPLATES` per type. Pure + test-first.
2. **Catalog** — partition `EXT_CATALOG` + templates by kind. Keep the pruned-but-retained third-party MCP templates (Postgres/Slack/…) on the MCP side; the planner's `<mcp_assign>` still resolves them.
3. **Store** — replace `extensions[]` with `mcpServers[]` + `hooks[]`; split the five actions into `addMcpServer`/`addHook`/…; resolve `paneExtensions` from both arrays (or expose `paneMcpServers`/`paneHooks`); update the project-deletion cleanup (`index.ts:~1550`) to scrub both; **persist migration** (§5).
4. **Screens** — extract `McpServersScreen` (Rail page; keeps install / `mcp_check_update` version logic / Analytics) and `HooksView` (Automations; no install/version). Drop the `kind` prop + `embedded` branching. Factor the shared row + drawer (name, enable toggle, project-scope picker, env editor) into one shared component to avoid duplication.
5. **Nav/routing** — rename route key `"extensions"` → `"mcp"` in `App.tsx` (case + render), `Rail.tsx` (`Screen` union + nav item), titlebar parts, `activeScreen`. Hooks stays mounted in Automations (Open Decision 1).
6. **Planner** — `screens/planner/shared/planExtensions.ts` (`<mcp_assign>`) and `blueprints/blueprintMcp.ts` are already MCP-only; retarget imports to `lib/mcpServers.ts`.
7. **Files/tests** — `screens/extensions/` → `screens/mcp/`; split `lib/extensionsLib.test.ts` → `mcpServers.test.ts` + `hooks.test.ts`; split `screens/extensions/extensions.test.tsx`; update `store/store.test.ts`, `planExtensions.test.ts`, blueprint tests, `consoleCrossTabMount.test.tsx`.
8. **Backend (Rust)** — wire format already split; `ensure_session_settings` should need no change. Verify payload field names still match after the rename.

## 5. Persisted-state migration — the one thing that can bite users

The persist config (`store/index.ts`, `name: "app-state"`) has **no `version`/`migrate`**; it uses `onRehydrateStorage` for fix-ups (the blueprints `refreshBuiltIns` pattern). `extensions` **is** persisted (partialize). Migration steps, done in `onRehydrateStorage`:

- Split a persisted `extensions: ExtensionDef[]` into `mcpServers` / `hooks` by `kind` (strip `kind`), then drop `extensions`.
- Map a persisted `activeScreen: "extensions"` → `"mcp"`.
- Map a persisted `usePageTabs` layout key `extensions-mcp` → the new key if it changes.

Miss this and a user's installed servers/hooks silently vanish on upgrade.

## 6. Issue breakdown (branch off `develop`, sequenced)

| Issue | Title | Depends on | Key acceptance |
|---|---|---|---|
| **A** | Split the extension model + catalog | — | `lib/mcpServers.ts`/`lib/hooks.ts`/`lib/sessionConfig.ts` + split catalogs; unit tests; no `ExtensionDef` left in `lib/` |
| **B** | Split the store + persist migration | A | `mcpServers[]`/`hooks[]` + paired actions; `onRehydrateStorage` migration; project-cleanup covers both; `store.test.ts` updated incl. a migration regression test |
| **C** | MCP servers screen + route rename | B | `screens/mcp/`; route `mcp`; install/version/analytics intact; `activeScreen` migration |
| **D** | Hooks view extraction | B | `HooksView` in Automations; no MCP-only machinery; `kind` prop gone |
| **E** | Retarget planner + blueprints | A | `planExtensions.ts`/`blueprintMcp.ts` on `lib/mcpServers.ts`; tests green |
| **F** | Naming/file moves + docs + topics | C, D, E | no `extensions` vocabulary in live MCP/hook code; docs + repo topics updated; Open Decision 2 resolved |

Sequence: **A → B → (C ∥ D) → E → F.** Each issue is one branch, tests in-branch, PR → `develop`.

## 7. Open decisions (recommendations — confirm before issues are cut)

1. **Hooks placement.** *Recommend: keep Hooks embedded in Automations* (status quo). #865 placed it there deliberately — hooks are lifecycle automations adjacent to Schedules/Commands. Promoting Hooks to its own Rail entry is a clean follow-up if desired, but isn't required by the split.
2. **The `lib/extensions/` directory** (`manifest.ts` + `gist.ts`, the blueprint-share manifest). *Recommend: rename to `lib/gist/` in pass F* for clarity, since it has nothing to do with MCP/hooks. Alternative: leave it (separate concern, separate session).

## 8. Risks

- **Data loss** if the persisted `extensions` migration is missed (§5) — highest-priority test.
- `activeScreen: "extensions"` persisted → blank screen unless migrated/aliased.
- Shared drawer/row UI duplicated across the two screens if not factored (step 4).
- Catalog partition must keep the planner's `<mcp_assign>` name-resolution working (the retained third-party templates).
