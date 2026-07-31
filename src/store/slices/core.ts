// CoreSlice — the residual of the former `automations` grab-bag after the automations CRUD moved
// to the Automations feature slice (@/features/automations/store, #1309) and the API-tier LLM
// provider config moved to the LlmSettings slice (#2715). Now: active-project / draft state + the
// projects-page view state. Typed Pick<AppStore, …>.
import type { StateCreator } from "zustand";
// LEAF import, not the barrel (#3245): `src/store/**` importing `@/features/planner` creates a
// module-init cycle — it broke five unrelated tunnel tests when this first went in as a barrel.
import { setDbTriaged } from "@/features/planner/list/projectsDbBridge";
import type { AppStore } from "../types";
import { setMapEntry, deleteMapEntry } from "../updateHelpers";
import { projectLinkId } from "@/features/glance/lib/projectLinks";
import { loadProjectLinks, pushProjectLink, dropProjectLink } from "@/features/glance/lib/projectLinksBridge";

type CoreSlice = Pick<AppStore,
  "projectsPageMode" | "setProjectsPageMode" | "glanceDrill" | "setGlanceDrill" | "previewSources" | "setPreviewSource" | "previewBuilding" | "setPreviewBuilding" | "reviewFindings" | "setReviewFindings" | "teamsDrill" | "setTeamsDrill" | "projectLinks" | "addProjectLink" | "removeProjectLink" | "hydrateProjectLinks" | "projectsView" | "setProjectsView" | "activeProjectId" | "activeProjectName" | "activeProjectRepo" | "activeProjectRepos" | "activeProjectNumber" | "setActiveProject" | "setActiveProjectMeta" | "hiddenProjectIds" | "dismissProject" | "addDraftProject" | "updateDraftProject" | "removeDraftProject" | "triagedProjects" | "markProjectTriaged" | "hydrateTriaged"
>;

export const createCoreSlice: StateCreator<AppStore, [], [], CoreSlice> = (set) => ({
      projectsPageMode: "projects",
      setProjectsPageMode: (v) => set({ projectsPageMode: v }),
      glanceDrill: null,
      setGlanceDrill: (id) => set({ glanceDrill: id }),
      // Verify-preview (#2623): the built PreviewSource + in-flight flag per project (transient).
      previewSources: {},
      setPreviewSource: (key, source) => set((s) => ({ previewSources: { ...s.previewSources, [key]: source } })),
      previewBuilding: {},
      setPreviewBuilding: (key, building) => set((s) => ({ previewBuilding: { ...s.previewBuilding, [key]: building } })),
      // Preview-review findings per project (#2623 slice 5b, transient) — the confirm-gated inbox.
      reviewFindings: {},
      setReviewFindings: (key, findings) => set((s) => ({ reviewFindings: { ...s.reviewFindings, [key]: findings } })),
      teamsDrill: null,
      setTeamsDrill: (id) => set({ teamsDrill: id }),

      // #2253 → #3786 write-through cache over `bsc project link` — hydrate authoritative on boot, each
      // mutation pushes through the bridge so agents (and a restart) see the same contracts. `target`
      // (#3786) names a non-project endpoint (a service / mcp server); a project↔project contract leaves it
      // absent so the persisted/wire shape stays byte-identical to the pre-#3786 model.
      projectLinks: [],
      addProjectLink: (from, to, kind, target) => {
        // A self-loop is only meaningless for a project target — an external service/mcp endpoint lives in
        // its own namespace, so `from === to` there is a legitimate contract (matches the Rust add_contract).
        if (from === to && (!target || target.type === "project")) return;
        const id = projectLinkId(from, to, kind);
        // Only a non-project target is stored on the link (keeps a project contract byte-identical).
        const external = target && target.type !== "project" ? target : undefined;
        let added = false;
        set((s) => {
          if (s.projectLinks.some((l) => l.id === id)) return {};
          added = true;
          return { projectLinks: [...s.projectLinks, { id, from, to, kind, ...(external ? { target: external } : {}) }] };
        });
        // Keep the plain project-link call at 3 args (a trailing undefined is a distinct arity to
        // `toHaveBeenCalledWith`) so the pre-#3786 write-through contract is unchanged.
        if (added) void (external ? pushProjectLink(from, to, kind, external) : pushProjectLink(from, to, kind));
      },
      removeProjectLink: (id) => {
        set((s) => ({ projectLinks: s.projectLinks.filter((l) => l.id !== id) }));
        void dropProjectLink(id);
      },
      hydrateProjectLinks: async () => {
        const loaded = await loadProjectLinks();
        if (loaded) set({ projectLinks: loaded }); // bridge unreachable → keep the persisted cache
      },
      projectsView: "list",
      setProjectsView: (v) => set({ projectsView: v }),
      activeProjectId: null,
      activeProjectName: "",
      activeProjectRepo: "",
      activeProjectRepos: [],
      activeProjectNumber: 0,
      setActiveProject: (id) => set({ activeProjectId: id }),
      // The node id is API-only meta (#2409): the project's data/folder key derives from its NAME
      // (`projectSlug`), so there is no node-id → key alias to record here anymore.
      setActiveProjectMeta: (id, name, repo, number, repos = []) =>
        set({
          activeProjectId: id, activeProjectName: name, activeProjectRepo: repo, activeProjectNumber: number, activeProjectRepos: repos,
        }),
      hiddenProjectIds: [],
      dismissProject: (id) =>
        set((s) => (!id || s.hiddenProjectIds.includes(id) ? {} : { hiddenProjectIds: [...s.hiddenProjectIds, id] })),
      addDraftProject: (key, draft) =>
        set((s) => ({ localDraftProjects: setMapEntry(s.localDraftProjects, key, draft) })),
      // Patch a draft record in place (#1222) — used to persist a title edit so it survives a
      // reopen. Keyed by the FROZEN key (not re-derived from the new title), so the on-disk folder
      // stays put. No-ops if the draft is gone.
      updateDraftProject: (key, patch) =>
        set((s) => {
          const cur = s.localDraftProjects[key];
          if (!cur) return {};
          return { localDraftProjects: setMapEntry(s.localDraftProjects, key, { ...cur, ...patch }) };
        }),
      removeDraftProject: (key) =>
        set((s) => ({ localDraftProjects: deleteMapEntry(s.localDraftProjects, key) })),
      // TRIAGED marker (#2541) — the drafted→triaged transition that gates the Glance network.
      // Idempotent: keeps the first timestamp so re-triaging doesn't reset it.
      //
      // #4088 — `projects.db` is the SOURCE; this map is an in-memory cache hydrated at boot, exactly
      // like skills/personas/teams. It used to live only in app-state.json, where no `bsc` command
      // could read or repair it and an app-state reset silently emptied the Glance network.
      triagedProjects: {},
      markProjectTriaged: (key) => {
        if (!key) return;
        // Write through FIRST so the durable marker lands even if this session never persists again.
        // `set` is idempotent server-side too, so a re-triage cannot rewrite the original timestamp.
        void setDbTriaged(key);
        set((s) => (s.triagedProjects[key] ? {} : { triagedProjects: { ...s.triagedProjects, [key]: Date.now() } }));
      },
      /** Replace the cache from `projects.db` (#4088), UNIONED with whatever is already in memory.
       *
       *  Union, not replace: a marker set in this session before hydration finished (or by a pre-#4088
       *  app-state that has not migrated yet) must not be dropped on the floor — losing one makes a
       *  worked project vanish from Glance, which is the exact bug this move exists to end. */
      hydrateTriaged: (fromDb) =>
        set((s) => ({ triagedProjects: { ...fromDb, ...s.triagedProjects } })),
});
