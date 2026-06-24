// Skills feature store slice (#1309) — extracted from the former `session` grab-bag slice. Owns the
// skill library, the resolved per-pane set, per-session overrides, and task groups. Composed into
// the single app store by store/index.ts.
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import type { KbBlock } from "@/data/mock";
import type { SkillPayload } from "@/screens/planner/blueprints/blueprintSkills";
import {
  seedSkills, skillFromPayload, applySessionSkillChoice, skillSlug,
  type SkillDef, type SessionSkillOverride, type SkillGroup,
} from "./lib/skills";

export interface SkillsSlice {
  // Skills — reusable capability bundles (prompt + bundled tools + profile guardrails) the fleet can
  // invoke, each scoped via its `projects` ([] = global). Written into a launched session's
  // .claude/skills/<slug>/SKILL.md. Seeded from the sample library; persisted. (#404)
  skills: SkillDef[];
  /** Reconstitute a shared blueprint's embedded skills/KB into the libraries (#897 Phase 5b). */
  installBundledSkills: (payloads: SkillPayload[]) => void;
  addSkill: (def: Omit<SkillDef, "id">) => string;
  updateSkill: (id: string, patch: Partial<SkillDef>) => void;
  removeSkill: (id: string) => void;
  toggleSkill: (id: string) => void;
  toggleSkillPin: (id: string) => void;
  setSkillProjects: (id: string, projects: string[]) => void;
  /** Upsert planner-authored skills (skills.json), by id then name-slug, refining in place. */
  upsertSkills: (defs: Array<Omit<SkillDef, "id"> & { id?: string }>) => void;
  // Resolved per-pane skills (transient): set at session creation, read by TerminalView before
  // launch. Computed via effectiveSessionSkills so it already reflects overrides + groups.
  paneSkills: Record<string, SkillDef[]>;
  // Per-session skill choices, keyed by the session's STABLE identity id; persisted (#1056).
  sessionSkillOverrides: Record<string, SessionSkillOverride>;
  setSessionSkill: (sessionKey: string, skillId: string, choice: "on" | "off" | "inherit") => void;
  /** Drop ALL per-session overrides AND group toggles for a session — back to pure inheritance. */
  resetSessionSkills: (sessionKey: string) => void;
  // Task groups (#skills-groups) — named, reusable skill bundles toggled as one. Persisted.
  skillGroups: SkillGroup[];
  addSkillGroup: (name: string, hue?: string) => string;
  updateSkillGroup: (id: string, patch: Partial<Omit<SkillGroup, "id">>) => void;
  removeSkillGroup: (id: string) => void;
  toggleSkillGroupMember: (groupId: string, skillId: string) => void;
  upsertSkillGroups: (groups: Array<Omit<SkillGroup, "id"> & { id?: string }>) => void;
  // Per-session enabled groups, keyed by the session's stable identity id; persisted.
  sessionSkillGroups: Record<string, string[]>;
  setSessionSkillGroup: (sessionKey: string, groupId: string, on: boolean) => void;
}

export const createSkillsSlice: StateCreator<AppStore, [], [], SkillsSlice> = (set) => ({
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
        const slug = skillSlug(def.name);
        const idx = skills.findIndex(
          (sk) => (def.id && sk.id === def.id) || skillSlug(sk.name) === slug,
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

  sessionSkillOverrides: {},
  setSessionSkill: (sessionKey, skillId, choice) =>
    set((s) => {
      const next = applySessionSkillChoice(s.sessionSkillOverrides[sessionKey], skillId, choice);
      const map = { ...s.sessionSkillOverrides };
      if (next.add.length === 0 && next.remove.length === 0) delete map[sessionKey];
      else map[sessionKey] = next;
      return { sessionSkillOverrides: map };
    }),
  resetSessionSkills: (sessionKey) =>
    set((s) => {
      const hadOverride = !!s.sessionSkillOverrides[sessionKey];
      const hadGroups = !!s.sessionSkillGroups[sessionKey];
      if (!hadOverride && !hadGroups) return {};
      const overrides = { ...s.sessionSkillOverrides };
      const groups = { ...s.sessionSkillGroups };
      delete overrides[sessionKey];
      delete groups[sessionKey];
      return { sessionSkillOverrides: overrides, sessionSkillGroups: groups };
    }),

  // ── Task groups (#skills-groups) ──────────────────────────────────────
  skillGroups: [],
  addSkillGroup: (name, hue) => {
    const id = `grp_${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({ skillGroups: [...s.skillGroups, { id, name, hue: hue ?? "var(--accent)", skillIds: [] }] }));
    return id;
  },
  updateSkillGroup: (id, patch) =>
    set((s) => ({ skillGroups: s.skillGroups.map((g) => (g.id === id ? { ...g, ...patch } : g)) })),
  removeSkillGroup: (id) =>
    set((s) => {
      const sessionSkillGroups: Record<string, string[]> = {};
      for (const [k, ids] of Object.entries(s.sessionSkillGroups)) {
        const kept = ids.filter((g) => g !== id);
        if (kept.length) sessionSkillGroups[k] = kept;
      }
      return { skillGroups: s.skillGroups.filter((g) => g.id !== id), sessionSkillGroups };
    }),
  toggleSkillGroupMember: (groupId, skillId) =>
    set((s) => ({
      skillGroups: s.skillGroups.map((g) => {
        if (g.id !== groupId) return g;
        const has = g.skillIds.includes(skillId);
        return { ...g, skillIds: has ? g.skillIds.filter((x) => x !== skillId) : [...g.skillIds, skillId] };
      }),
    })),
  upsertSkillGroups: (groups) =>
    set((s) => {
      const next = [...s.skillGroups];
      for (const g of groups) {
        const slug = skillSlug(g.name);
        const idx = next.findIndex((x) => (g.id && x.id === g.id) || skillSlug(x.name) === slug);
        if (idx >= 0) {
          const rest = { ...g }; delete rest.id;
          next[idx] = { ...next[idx], ...rest };
        } else {
          next.push({ ...g, id: g.id ?? `grp_${Math.random().toString(36).slice(2, 8)}` });
        }
      }
      return { skillGroups: next };
    }),
  sessionSkillGroups: {},
  setSessionSkillGroup: (sessionKey, groupId, on) =>
    set((s) => {
      const cur = s.sessionSkillGroups[sessionKey] ?? [];
      const next = on ? (cur.includes(groupId) ? cur : [...cur, groupId]) : cur.filter((g) => g !== groupId);
      const map = { ...s.sessionSkillGroups };
      if (next.length) map[sessionKey] = next;
      else delete map[sessionKey];
      return { sessionSkillGroups: map };
    }),
});
