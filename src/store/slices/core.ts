// CoreSlice — the residual of the former `automations` grab-bag after the automations CRUD moved
// to the Automations feature slice (@/features/automations/store, #1309). Still a mix: the API-tier
// LLM provider config and active-project / draft state. A candidate for a further split (settings vs
// projects) in a later pass. Typed Pick<AppStore, …>.
import type { StateCreator } from "zustand";
import type { AppStore } from "../types";
import { setMapEntry, deleteMapEntry } from "../updateHelpers";
import { modelOnProviderSwitch } from "@/shared/lib/core/llmConfig";

type CoreSlice = Pick<AppStore,
  "claudeApiKey" | "setClaudeApiKey" | "llmProvider" | "setLlmProvider" | "llmModel" | "setLlmModel" | "openaiKey" | "setOpenaiKey" | "geminiKey" | "setGeminiKey" | "localBaseUrl" | "setLocalBaseUrl" | "projectsPageMode" | "setProjectsPageMode" | "glanceDrill" | "setGlanceDrill" | "projectsView" | "setProjectsView" | "activeProjectId" | "activeProjectName" | "activeProjectRepo" | "activeProjectRepos" | "activeProjectNumber" | "setActiveProject" | "setActiveProjectMeta" | "hiddenProjectIds" | "dismissProject" | "addDraftProject" | "updateDraftProject" | "removeDraftProject"
>;

export const createCoreSlice: StateCreator<AppStore, [], [], CoreSlice> = (set) => ({
      claudeApiKey: "",
      setClaudeApiKey: (key) => set({ claudeApiKey: key }),

      // API-tier LLM provider config (#1085). claudeApiKey is the anthropic key.
      llmProvider: "anthropic",
      // Switch the model field to the new provider's default when it still holds another provider's
      // default (a hosted `claude-*` model can't run on Ollama, and vice-versa) — a model the user
      // typed is preserved. So picking Ollama lands on `qwen3-coder` instead of a 404 on the Claude id.
      setLlmProvider: (p) => set((s) => ({ llmProvider: p, llmModel: modelOnProviderSwitch(p, s.llmModel) })),
      llmModel: "claude-sonnet-4-6",
      setLlmModel: (m) => set({ llmModel: m }),
      openaiKey: "",
      setOpenaiKey: (k) => set({ openaiKey: k }),
      geminiKey: "",
      setGeminiKey: (k) => set({ geminiKey: k }),
      localBaseUrl: "http://localhost:11434/v1",
      setLocalBaseUrl: (u) => set({ localBaseUrl: u }),

      projectsPageMode: "projects",
      setProjectsPageMode: (v) => set({ projectsPageMode: v }),
      glanceDrill: null,
      setGlanceDrill: (id) => set({ glanceDrill: id }),
      projectsView: "list",
      setProjectsView: (v) => set({ projectsView: v }),
      activeProjectId: null,
      activeProjectName: "",
      activeProjectRepo: "",
      activeProjectRepos: [],
      activeProjectNumber: 0,
      setActiveProject: (id) => set({ activeProjectId: id }),
      setActiveProjectMeta: (id, name, repo, number, repos = []) =>
        set((s) => ({
          activeProjectId: id, activeProjectName: name, activeProjectRepo: repo, activeProjectNumber: number, activeProjectRepos: repos,
          // First-write-wins: bind the GitHub node id to the folder/data key (the
          // title slug the plan files live under) so a board-path open resolves to
          // real data, not the empty node-id key. Frozen on first sighting so a
          // later GitHub rename can't clobber a working alias.
          projectKeyAlias: id && name && !s.projectKeyAlias[id]
            ? setMapEntry(s.projectKeyAlias, id, name)
            : s.projectKeyAlias,
        })),
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
});
