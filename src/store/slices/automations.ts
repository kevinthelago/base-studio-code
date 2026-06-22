// AutomationsSlice — extracted from the store implementation (store split, stage 2).
// Typed Pick<AppStore, …> so AppStore stays whole in types.ts while the create() composes slices.
import type { StateCreator } from "zustand";
import type { AppStore } from "../types";
import { type Automation, appendRun, computeNextRun } from "../../lib/automations/scheduler";
import type { Schedule, Command } from "../../data/mock";

type AutomationsSlice = Pick<AppStore,
  "kbBlocks" | "claudeApiKey" | "setClaudeApiKey" | "llmProvider" | "setLlmProvider" | "llmModel" | "setLlmModel" | "openaiKey" | "setOpenaiKey" | "geminiKey" | "setGeminiKey" | "localBaseUrl" | "setLocalBaseUrl" | "schedules" | "addSchedule" | "updateSchedule" | "removeSchedule" | "commands" | "addCommand" | "updateCommand" | "removeCommand" | "automations" | "addAutomation" | "updateAutomation" | "removeAutomation" | "setAutomationArmed" | "recordAutomationRun" | "projectsPageMode" | "setProjectsPageMode" | "projectsView" | "setProjectsView" | "activeProjectId" | "activeProjectName" | "activeProjectRepo" | "activeProjectRepos" | "activeProjectNumber" | "setActiveProject" | "setActiveProjectMeta" | "hiddenProjectIds" | "dismissProject" | "addDraftProject" | "removeDraftProject"
>;

export const createAutomationsSlice: StateCreator<AppStore, [], [], AutomationsSlice> = (set) => ({
      kbBlocks: [],
      claudeApiKey: "",
      setClaudeApiKey: (key) => set({ claudeApiKey: key }),

      // API-tier LLM provider config (#1085). claudeApiKey is the anthropic key.
      llmProvider: "anthropic",
      setLlmProvider: (p) => set({ llmProvider: p }),
      llmModel: "claude-sonnet-4-6",
      setLlmModel: (m) => set({ llmModel: m }),
      openaiKey: "",
      setOpenaiKey: (k) => set({ openaiKey: k }),
      geminiKey: "",
      setGeminiKey: (k) => set({ geminiKey: k }),
      localBaseUrl: "http://localhost:11434/v1",
      setLocalBaseUrl: (u) => set({ localBaseUrl: u }),

      schedules: [],
      addSchedule: () =>
        set((s) => {
          const id = `S-${String(s.schedules.length + 1).padStart(2, "0")}`;
          const newSched: Schedule = {
            id, name: "New schedule", on: false,
            when: "every day · 02:00", target: "",
            action: "command", detail: "",
            lastRun: "—", nextRun: "—",
          };
          return { schedules: [...s.schedules, newSched] };
        }),
      updateSchedule: (id, patch) =>
        set((s) => ({ schedules: s.schedules.map(sc => sc.id === id ? { ...sc, ...patch } : sc) })),
      removeSchedule: (id) =>
        set((s) => ({ schedules: s.schedules.filter(sc => sc.id !== id) })),

      commands: [],
      addCommand: () =>
        set((s) => {
          const id = `cmd_${Math.random().toString(36).slice(2, 8)}`;
          const newCmd: Command = { id, name: "New command", cmd: "", used: 0, tags: [] };
          return { commands: [...s.commands, newCmd] };
        }),
      updateCommand: (id, patch) =>
        set((s) => ({ commands: s.commands.map(c => c.id === id ? { ...c, ...patch } : c) })),
      removeCommand: (id) =>
        set((s) => ({ commands: s.commands.filter(c => c.id !== id) })),

      automations: [],
      addAutomation: (input) =>
        set((s) => {
          const id = `auto_${Math.random().toString(36).slice(2, 8)}`;
          const nextRunAt = input.armed ? computeNextRun(input.when, Date.now()) : null;
          const a: Automation = { ...input, id, lastRunAt: null, nextRunAt, runs: [] };
          return { automations: [...s.automations, a] };
        }),
      updateAutomation: (id, patch) =>
        set((s) => ({
          automations: s.automations.map(a => {
            if (a.id !== id) return a;
            const next = { ...a, ...patch };
            // Editing the trigger or arming re-derives the next fire time.
            if ("when" in patch || "armed" in patch) {
              next.nextRunAt = next.armed ? computeNextRun(next.when, Date.now()) : null;
            }
            return next;
          }),
        })),
      removeAutomation: (id) =>
        set((s) => ({ automations: s.automations.filter(a => a.id !== id) })),
      setAutomationArmed: (id, armed) =>
        set((s) => ({
          automations: s.automations.map(a =>
            a.id === id
              ? { ...a, armed, nextRunAt: armed ? computeNextRun(a.when, Date.now()) : null }
              : a),
        })),
      recordAutomationRun: (id, run) =>
        set((s) => ({
          automations: s.automations.map(a =>
            a.id === id
              ? { ...a, runs: appendRun(a.runs, run), lastRunAt: run.at, nextRunAt: computeNextRun(a.when, run.at) }
              : a),
        })),

      projectsPageMode: "projects",
      setProjectsPageMode: (v) => set({ projectsPageMode: v }),
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
            ? { ...s.projectKeyAlias, [id]: name }
            : s.projectKeyAlias,
        })),
      hiddenProjectIds: [],
      dismissProject: (id) =>
        set((s) => (!id || s.hiddenProjectIds.includes(id) ? {} : { hiddenProjectIds: [...s.hiddenProjectIds, id] })),
      addDraftProject: (key, draft) =>
        set((s) => ({ localDraftProjects: { ...s.localDraftProjects, [key]: draft } })),
      removeDraftProject: (key) =>
        set((s) => {
          const next = { ...s.localDraftProjects };
          delete next[key];
          return { localDraftProjects: next };
        }),
});
