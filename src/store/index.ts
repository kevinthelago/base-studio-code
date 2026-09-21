import { create } from "zustand";
import { bscJson, bscWrite } from "@/shared/lib/core/bsc";
import { persist } from "zustand/middleware";
import { persistStorage, throttledJSONStorage } from "@/shared/lib/core/storage";
import {       deriveTabIdentity } from "@/shared/lib/core/projectPaths";
import {  refreshBuiltIns, type Blueprint } from "@/features/planner/stages/blueprints";
import { reconcileBuiltInProfiles } from "@/shared/lib/security/agentProfiles";
import { migrateLegacyExtensions } from "@/features/mcp/lib/migrateExtensions";
import { createMcpSlice } from "@/features/mcp/store";
import { createPersonasSlice } from "@/features/personas/store";
import { reconcilePersonas } from "@/features/personas/lib/persona";
import { createOrgSlice } from "@/features/teams/store";
import { createNetworksSlice } from "@/features/networks";
import { createComponentsSlice } from "@/features/designs/store";
import { createAlgorithmsSlice } from "@/features/algorithms/store";
import { createStudiosSlice } from "@/features/studio-sessions/store";
import { reconcileOrgs } from "@/features/teams/lib/team";
import { refreshPackagedSkills } from "@/features/skills/lib/skills";
import { createSkillsSlice } from "@/features/skills/store";

import { type AppStore } from "@/store/types";
import { persistedState, migrateAutoResumeOff, migrateGithubCacheProvenance, migrateRenamedSurfacePanes } from "@/store/persist";
import { leanRepos } from "@/store/types/github";
import { migrateRetiredWorkspace, migrateGraphPage } from "@/store/retiredWorkspaces";
import { createSessionSlice } from "@/store/slices/session";
import { createPlanSlice } from "@/store/slices/plan";
import { createProjectsSlice } from "@/store/slices/projects";
import { createAutomationsSlice } from "@/features/automations/store";
import { createCoreSlice } from "@/store/slices/core";
import { createLlmSettingsSlice } from "@/store/slices/llmSettings";
import { createGithubSlice } from "@/features/github/store";
import { createShellSlice } from "@/store/slices/shell";
import { createTunnelSlice } from "@/features/tunnel/store";
import { createConsoleSlice } from "@/store/slices/console";

// Re-export the public store API so existing `from "@/store"` imports keep resolving.
export { PROJECT_INIT_PROMPT, TRIAGE_PROMPT, buildTriagePrompt } from "@/store/constants";
// The harness a pane launches on, DERIVED rather than assumed
// (`a-pane-harness-falls-back-to-its-stream`). Re-exported here because TerminalView — the one place
// that resolves it at launch — already imports from this barrel and must not reach into a slice.
export { paneHarness } from "@/store/slices/projects";
export type { GithubUser, PerfConfig, LogConfig, ToolPermissions, ConfigProfile, AutomationSuggestion, GithubRepo } from "@/store/types";

import { newTabId } from "@/store/helpers";

export const useAppStore = create<AppStore>()(
  persist(
    (set, get, store) => ({
      ...createAlgorithmsSlice(set, get, store),
      ...createConsoleSlice(set, get, store),
      ...createGithubSlice(set, get, store),
      ...createShellSlice(set, get, store),
      ...createTunnelSlice(set, get, store),

      ...createCoreSlice(set, get, store),
      ...createLlmSettingsSlice(set, get, store),
      ...createAutomationsSlice(set, get, store),
      ...createProjectsSlice(set, get, store),

      ...createPlanSlice(set, get, store),
      ...createSessionSlice(set, get, store),
      ...createSkillsSlice(set, get, store),
      ...createMcpSlice(set, get, store),
      ...createPersonasSlice(set, get, store),
      ...createOrgSlice(set, get, store),
      ...createNetworksSlice(set, get, store),
      ...createComponentsSlice(set, get, store),
      // #3357: the app-owned studio sessions' lifecycle (wanted set + viewer ref-counts). Transient —
      // deliberately absent from `partialize`, so nothing launches at boot.
      ...createStudiosSlice(set, get, store),
    }),
    {
      name: "app-state",
      // THROTTLED SERIALIZATION, not `createJSONStorage`. That helper stringifies the whole ~129 KB
      // partialized snapshot on EVERY store `set()` — including writes to fields that are not
      // persisted at all — and a native stack caught the main thread inside
      // `appendQuotedJSONString` while the renderer went 77 MB to 6.4 GB in nineteen seconds.
      // `persistStorage`'s own throttle sits downstream of the stringify and saves only I/O.
      //
      // Typed on the PARTIALIZED shape, not `AppStore`: `partialize` is what persist actually stores,
      // so anything else would be a claim about a value that never reaches the storage.
      storage: throttledJSONStorage<ReturnType<typeof persistedState>>(persistStorage),
      version: 4,
      // The #2548 triaged grandfather lived here and is GONE with the gate it fed (#2541 retired). It
      // backfilled a marker so that already-worked projects would not vanish from Glance on upgrade —
      // a repair for a filter that no longer exists, and nothing now hides a project for want of it.
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Partial<AppStore>;
        // v2 (#restart-does-not-resume-sessions): turn silent auto-resume off once. Named + exported
        // so the one-time-ness is testable on its own — see `migrateAutoResumeOff`.
        migrateAutoResumeOff(s, version);
        // v3 (`frontend-state-7-the-github-cluster-is-an-honest-cache`): drop a cached GitHub value that
        // predates the fetch-time fields, since nothing can say when it was loaded. It is a cache, so one
        // reconnect restores it — and `githubConnected`/`activeRepoName` are deliberately left alone.
        migrateGithubCacheProvenance(s as Record<string, unknown>, version);
        // v4 (`a-renamed-noun-strands-its-surface-studio-pane`): a surface-studio pane id encodes its
        // NOUN, so a renamed noun strands its pane — the launch plan refuses ("no crate drill serves
        // `bsc ui`") and Glance's click is silently dead. Moves the pane rather than aliasing the noun.
        migrateRenamedSurfacePanes(s as Record<string, unknown>, version);
        return s as AppStore;
      },
      // Exclude transient UI-only state — and anything a `bsc` store owns + re-hydrates at boot
      // (#3610, e.g. the 592 KB `components` library) — from the persisted snapshot. The allowlist is a
      // named, testable function so a heavy field can't silently ride along again. See store/persist.ts.
      partialize: persistedState,
      // Storage is async (Tauri plugin-store), so hydration finishes AFTER the
      // first render. Flip hasHydrated here so the shell can hold its first paint
      // until the persisted state is in — otherwise screens flash from defaults
      // (e.g. GitHub "not connected" → connected) on every load.
      onRehydrateStorage: () => (state) => {
        // Back-fill stable identity onto tabs persisted before these fields existed.
        // #463: a stable `id` (detached set / re-dock / order key off it). #457: the
        // project-tab identity (projectKey/kind/seq), derived once from the frozen name
        // so the next fleet/triage launch can find-and-reuse the tab instead of forking
        // a duplicate. Both are one-time legacy upgrades and no-ops thereafter.
        // Normalise a legacy persisted repo list to its declared fields (#githubrepos-projected…).
        // A one-time upgrade, like the tab back-fills below: `setGithubRepos` keeps every FUTURE write
        // lean, but it only runs on connect, so without this an existing install carries ~494 KB of
        // unread `*_url` templates — through every `JSON.stringify` the persist middleware does per
        // store `set()` — until the user happens to reconnect.
        if (state?.githubRepos?.length) {
          state.githubRepos = leanRepos(state.githubRepos as unknown as Record<string, unknown>[]);
        }
        if (state?.tabs) {
          state.tabs = state.tabs.map((t) => {
            let next = t.id ? t : { ...t, id: newTabId() };
            if (!next.projectKey && !next.kind) {
              const ident = deriveTabIdentity(next.name);
              if (ident) next = { ...next, ...ident };
            }
            return next;
          });
        }
        // Migrate the legacy unified `extensions` list → split `mcpServers` / `hooks` slices and
        // the renamed MCP route key (#mcp-hooks-split). One-time; no-op once migrated.
        migrateLegacyExtensions(state);
        // The Blueprints page-mode was folded into the Planner tab's blueprint rail (#blueprints);
        // a user whose last mode was it would otherwise land on a blank canvas.
        if (state && (state.projectsPageMode as string) === "blueprints") state.projectsPageMode = "projects";
        // Personas was folded into the Teams page (#2199) — a last-mode of "personas" now opens Teams.
        if (state && (state.projectsPageMode as string) === "personas") state.projectsPageMode = "teams";
        // The Teams page-mode id was renamed "org" → "teams" (#2700) — map a last-mode of "org" forward.
        if (state && (state.projectsPageMode as string) === "org") state.projectsPageMode = "teams";
        // The Fleet page-mode was folded into Glance (#2223/#2228) — a last-mode of "fleet" opens Projects.
        if (state && (state.projectsPageMode as string) === "fleet") state.projectsPageMode = "projects";
        // Every RETIRED rail Workspace's redirect, in one place (`store/retiredWorkspaces.ts`).
        // `activeWorkspace` is persisted, so removing a Workspace strands whoever was last on it —
        // they reopen pointed at a key the shell cannot render. Inline, these could not be tested,
        // and design/algorithms/agents had shipped with no assertion between them.
        migrateRetiredWorkspace(state);
        // The Designs page-mode key was renamed "design" → "designs" (#2701, feature-folder rename to
        // match the on-screen "Designs" tab). A user whose last page-mode was "design" now opens "designs".
        if (state && (state.projectsPageMode as string) === "design") state.projectsPageMode = "designs";
        // The standalone Themes page-mode was retired (#2850) — theme viewing folded into the Components
        // tab's theme try-on preview (right-pane themes menu + palette + big preview). A last-mode of
        // "themes" now opens Components (Designs).
        if (state && (state.projectsPageMode as string) === "themes") state.projectsPageMode = "designs";
        // The five graphs left the Planner and became rail Workspaces
        // (`five-graphs-become-rail-workspaces`), so a persisted page-mode naming one has to be
        // forwarded to the Workspace it became.
        //
        // ORDER IS LOAD-BEARING: this runs AFTER the two page-mode RENAMES above, not before. A user
        // whose last mode was "design" or "themes" is only spelled "designs" once those have run, and
        // "designs" is the key this maps to Components. Hoisting this above them would leave both of
        // those users on the Planner — the exact silent wrong-page this migration exists to prevent,
        // and one that nothing would report because it looks like a normal Projects view.
        migrateGraphPage(state);
        // Refresh BUILT-IN blueprints from code on every load (#677). They're code-owned
        // templates, but `blueprints` is persisted — so improvements to a built-in (the
        // `optional` UI stage, enabled repos, updated prompts, …) would never reach a user
        // who seeded their store before the change. We replace each persisted built-in with
        // its current definition (by id) and add any new built-ins; user-created / forked /
        // imported blueprints are left untouched.
        // Reconcile the persona library with the packaged built-ins (#2094): re-seed any dropped
        // built-in, restore built-in identity, and keep user edits + user-authored personas. Same
        // code-owned-template discipline as the blueprints refresh below.
        if (state?.personas) state.personas = reconcilePersonas(state.personas);
        // #2700: the org feature was renamed "teams" — its persisted store fields `orgs`/`orgZoom` are now
        // `teams`/`teamsZoom`. Map an existing on-disk snapshot's old keys onto the new ones so a user's
        // saved teams + per-team zoom survive the rename (the JSON shape is unchanged; only key names moved).
        if (state) {
          const legacy = state as unknown as Record<string, unknown>;
          if (legacy.orgs !== undefined && legacy.teams === undefined) legacy.teams = legacy.orgs;
          if (legacy.orgZoom !== undefined && legacy.teamsZoom === undefined) legacy.teamsZoom = legacy.orgZoom;
          delete legacy.orgs;
          delete legacy.orgZoom;
        }
        // Same discipline for the team library (#2193): re-seed dropped built-ins, restore built-in
        // identity, keep user edits + user-authored teams.
        if (state?.teams) state.teams = reconcileOrgs(state.teams);
        if (state?.blueprints) {
          state.blueprints = refreshBuiltIns(state.blueprints);
        }
        // Same idea for permission profiles: refresh the built-ins from the role JSON, drop retired
        // demos + stale generated profiles, keep the user's customs (the unified role→profile model).
        if (state?.agentProfiles) {
          state.agentProfiles = reconcileBuiltInProfiles(state.agentProfiles);
        }
        // The #2548 REPAIR backfill stood here and is GONE. `triagedProjects` is not persisted, so it
        // was empty on EVERY boot and this fired on every boot — a `list_local_projects` round trip and
        // a setState, purely to re-seed a marker that a filter would otherwise have used to hide the
        // whole network. With the filter retired there is nothing to repair.
        // Hydrate user blueprints from their on-disk dir (#blueprints) over the `bsc` bridge
        // (`bsc blueprint list --full`, #2143): union them in (so one that survived a store reset or a
        // fresh download appears), and migrate any persisted-but-not-yet-on-disk user blueprint forward
        // to the dir (`bsc blueprint set`). The dir is the durable home; the persisted list is a cache;
        // built-ins stay code-owned. Blueprints are GLOBAL (no project key) → `null`. `bscJson` degrades
        // to `[]` when the bridge is unreachable — safe here: an empty list simply unions nothing (the
        // `if (fromDir.length)` guard), so it never blanks the seeded/persisted set. Async — runs after
        // hydration settles.
        void bscJson<unknown[]>(null, ["blueprint", "list", "--full"], []).then((rows) => {
          const coerce = (b: unknown): Blueprint | undefined =>
            b && typeof (b as Blueprint).id === "string" && Array.isArray((b as Blueprint).sections)
              ? (b as Blueprint)
              : undefined;
          const fromDir = rows.map(coerce).filter((b): b is Blueprint => !!b && b.origin !== "built-in");
          const onDiskIds = new Set(fromDir.map((b) => b.id));
          if (fromDir.length) {
            useAppStore.setState((s) => {
              const byId = new Map(s.blueprints.map((b) => [b.id, b]));
              for (const b of fromDir) byId.set(b.id, b); // the dir wins for user blueprints
              return { blueprints: [...byId.values()] };
            });
          }
          for (const b of useAppStore.getState().blueprints) {
            if (b.origin !== "built-in" && !onDiskIds.has(b.id)) {
              void bscWrite(null, ["blueprint", "set"], b);
            }
          }
        });
        // Same for the packaged skills (#677-style): replace the code-owned set from
        // code and prune any retired packaged skill, so a store seeded with the old
        // dev-workflow skills picks up the compliance/standards library on next load.
        if (state?.skills) {
          state.skills = refreshPackagedSkills(state.skills);
        }
        // Release the gate once hydration settles — on success or error — so the
        // shell never hangs on a blank canvas (on error the store keeps defaults).
        (state ?? useAppStore.getState()).setHasHydrated(true);
      },
    }
  )
);
