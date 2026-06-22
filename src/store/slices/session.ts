// SessionSlice — extracted from the store implementation (store split, stage 2).
// Typed Pick<AppStore, …> so AppStore stays whole in types.ts while the create() composes slices.
import type { StateCreator } from "zustand";
import type { AppStore } from "../types";
import { seedSkills, skillFromPayload, type SkillDef } from "../../lib/session/skills";
import type { KbBlock } from "../../data/mock";
import { repoPromptKey } from "../../lib/session/startupPrompt";
import { DEFAULT_AUTO_FOCUS_MODE } from "../../lib/console/focusQueue";

type SessionSlice = Pick<AppStore,
  "mcpServers" | "addMcpServer" | "updateMcpServer" | "removeMcpServer" | "toggleMcpServer" | "setMcpServerProjects" | "hooks" | "addHook" | "updateHook" | "removeHook" | "toggleHook" | "setHookProjects" | "paneMcpServers" | "paneHooks" | "skills" | "addSkill" | "installBundledSkills" | "updateSkill" | "removeSkill" | "toggleSkill" | "toggleSkillPin" | "setSkillProjects" | "upsertSkills" | "paneSkills" | "allowedCommands" | "addAllowedCommand" | "removeAllowedCommand" | "setAllowedCommands" | "deniedCommands" | "addDeniedCommand" | "removeDeniedCommand" | "setDeniedCommands" | "projectAllowedCommands" | "addProjectAllowedCommand" | "removeProjectAllowedCommand" | "repoAllowedCommands" | "addRepoAllowedCommand" | "removeRepoAllowedCommand" | "paneAllowedCommands" | "autoFocusMode" | "setAutoFocusMode" | "autoAdvanceOnReply" | "setAutoAdvanceOnReply" | "autoResumeClaude" | "setAutoResumeClaude" | "autoPlanWithClaude" | "setAutoPlanWithClaude" | "autoCompleteGates" | "setAutoCompleteGates" | "restrictToBscIssues" | "setRestrictToBscIssues" | "coordAutoWake" | "setCoordAutoWake" | "defaultModel" | "setDefaultModel" | "paneModels" | "setPaneModel"
>;

export const createSessionSlice: StateCreator<AppStore, [], [], SessionSlice> = (set) => ({
      mcpServers: [],
      addMcpServer: (def) =>
        set((s) => ({
          mcpServers: [...s.mcpServers, { ...def, id: `mcp_${Math.random().toString(36).slice(2, 8)}` }],
        })),
      updateMcpServer: (id, patch) =>
        set((s) => ({ mcpServers: s.mcpServers.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),
      removeMcpServer: (id) =>
        set((s) => ({ mcpServers: s.mcpServers.filter((e) => e.id !== id) })),
      toggleMcpServer: (id) =>
        set((s) => ({ mcpServers: s.mcpServers.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)) })),
      setMcpServerProjects: (id, projects) =>
        set((s) => ({ mcpServers: s.mcpServers.map((e) => (e.id === id ? { ...e, projects } : e)) })),
      hooks: [],
      addHook: (def) =>
        set((s) => ({
          hooks: [...s.hooks, { ...def, id: `hook_${Math.random().toString(36).slice(2, 8)}` }],
        })),
      updateHook: (id, patch) =>
        set((s) => ({ hooks: s.hooks.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),
      removeHook: (id) =>
        set((s) => ({ hooks: s.hooks.filter((e) => e.id !== id) })),
      toggleHook: (id) =>
        set((s) => ({ hooks: s.hooks.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)) })),
      setHookProjects: (id, projects) =>
        set((s) => ({ hooks: s.hooks.map((e) => (e.id === id ? { ...e, projects } : e)) })),
      paneMcpServers: {},
      paneHooks: {},

      skills: seedSkills(),
      addSkill: (def) => {
        const id = `skill_${Math.random().toString(36).slice(2, 8)}`;
        set((s) => ({ skills: [...s.skills, { ...def, id }] }));
        return id;
      },
      installBundledSkills: (payloads) =>
        set((s) => {
          const haveSkill = new Set(s.skills.map((x) => x.id));
          const haveKb = new Set(s.kbBlocks.map((x) => x.id));
          const newSkills: SkillDef[] = [];
          const newKb: KbBlock[] = [];
          for (const p of payloads) {
            if (p.kind === "kb") {
              if (haveKb.has(p.id) || !p.id) continue;
              haveKb.add(p.id);
              newKb.push({ id: p.id, title: p.name, tags: p.tags ?? [], updated: "imported", lines: (p.content ?? "").split("\n").length, content: p.content });
            } else {
              if (haveSkill.has(p.id) || !p.id) continue;
              haveSkill.add(p.id);
              newSkills.push(skillFromPayload(p));
            }
          }
          if (newSkills.length === 0 && newKb.length === 0) return {};
          return { skills: [...s.skills, ...newSkills], kbBlocks: [...s.kbBlocks, ...newKb] };
        }),
      updateSkill: (id, patch) =>
        set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, ...patch } : sk)) })),
      removeSkill: (id) =>
        set((s) => ({ skills: s.skills.filter((sk) => sk.id !== id) })),
      toggleSkill: (id) =>
        set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, enabled: !sk.enabled } : sk)) })),
      toggleSkillPin: (id) =>
        set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, pinned: !sk.pinned } : sk)) })),
      setSkillProjects: (id, projects) =>
        set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, projects } : sk)) })),
      upsertSkills: (defs) =>
        set((s) => {
          const skills = [...s.skills];
          for (const def of defs) {
            // Match by explicit id first, then by name-slug, so a re-emitted
            // definition refines the existing skill in place.
            const slug = def.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
            const idx = skills.findIndex(
              (sk) => (def.id && sk.id === def.id) ||
                sk.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") === slug,
            );
            if (idx >= 0) {
              const rest = { ...def };
              delete rest.id;
              skills[idx] = { ...skills[idx], ...rest };
            } else {
              skills.push({ ...def, id: def.id ?? `skill_${Math.random().toString(36).slice(2, 8)}` });
            }
          }
          return { skills };
        }),
      paneSkills: {},

      allowedCommands: [],
      addAllowedCommand: (cmd) =>
        set((s) => ({
          allowedCommands: s.allowedCommands.includes(cmd)
            ? s.allowedCommands
            : [...s.allowedCommands, cmd],
        })),
      removeAllowedCommand: (cmd) =>
        set((s) => ({ allowedCommands: s.allowedCommands.filter((c) => c !== cmd) })),
      setAllowedCommands: (commands) => set({ allowedCommands: commands }),

      deniedCommands: [],
      addDeniedCommand: (cmd) =>
        set((s) => {
          const c = cmd.trim().toLowerCase();
          if (!c || s.deniedCommands.includes(c)) return {};
          return { deniedCommands: [...s.deniedCommands, c] };
        }),
      removeDeniedCommand: (cmd) =>
        set((s) => ({ deniedCommands: s.deniedCommands.filter((c) => c !== cmd) })),
      setDeniedCommands: (commands) => set({ deniedCommands: commands }),

      projectAllowedCommands: {},
      addProjectAllowedCommand: (projectId, cmd) =>
        set((s) => {
          const c = cmd.trim().toLowerCase();
          const cur = s.projectAllowedCommands[projectId] ?? [];
          if (!c || cur.includes(c)) return {};
          return { projectAllowedCommands: { ...s.projectAllowedCommands, [projectId]: [...cur, c] } };
        }),
      removeProjectAllowedCommand: (projectId, cmd) =>
        set((s) => ({
          projectAllowedCommands: {
            ...s.projectAllowedCommands,
            [projectId]: (s.projectAllowedCommands[projectId] ?? []).filter((x) => x !== cmd),
          },
        })),
      repoAllowedCommands: {},
      addRepoAllowedCommand: (projectId, repo, cmd) =>
        set((s) => {
          const key = repoPromptKey(projectId, repo);
          const c = cmd.trim().toLowerCase();
          const cur = s.repoAllowedCommands[key] ?? [];
          if (!c || cur.includes(c)) return {};
          return { repoAllowedCommands: { ...s.repoAllowedCommands, [key]: [...cur, c] } };
        }),
      removeRepoAllowedCommand: (projectId, repo, cmd) =>
        set((s) => {
          const key = repoPromptKey(projectId, repo);
          return {
            repoAllowedCommands: {
              ...s.repoAllowedCommands,
              [key]: (s.repoAllowedCommands[key] ?? []).filter((x) => x !== cmd),
            },
          };
        }),
      paneAllowedCommands: {},

      autoFocusMode: DEFAULT_AUTO_FOCUS_MODE,
      setAutoFocusMode: (mode) => set({ autoFocusMode: mode, autoAdvanceOnReply: mode !== "off" }),
      autoAdvanceOnReply: true,
      // Back-compat: syncs to autoFocusMode.
      setAutoAdvanceOnReply: (v) => set({ autoAdvanceOnReply: v, autoFocusMode: v ? "cycle-on-reply" : "off" }),

      autoResumeClaude: true,
      setAutoResumeClaude: (v) => set({ autoResumeClaude: v }),

      autoPlanWithClaude: false,
      setAutoPlanWithClaude: (v) => set({ autoPlanWithClaude: v }),

      autoCompleteGates: false,
      setAutoCompleteGates: (v) => set({ autoCompleteGates: v }),

      restrictToBscIssues: true, // secure by default (#738)
      setRestrictToBscIssues: (v) => set({ restrictToBscIssues: v }),
      coordAutoWake: false,
      setCoordAutoWake: (v) => set({ coordAutoWake: v }),

      defaultModel: "sonnet-4.5",
      setDefaultModel: (m) => set({ defaultModel: m }),
      paneModels: {},
      setPaneModel: (paneId, m) =>
        set((s) => ({ paneModels: { ...s.paneModels, [paneId]: m } })),
});
