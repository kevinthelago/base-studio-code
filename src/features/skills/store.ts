// Skills feature store slice (#1309) — extracted from the former `session` grab-bag slice. Owns the
// skill library, the resolved per-pane set, per-session overrides, and task groups. Composed into
// the single app store by store/index.ts.
//
// Source of truth is the GLOBAL skills.db (#1338 ph2): this slice is a write-through cache. On boot
// `hydrateSkills` loads the library from the `skill_store_*` bridge and reconciles the code-owned
// packaged set; every library mutation below pushes through to the bridge so the desktop UI, the
// planner, and every live `bsc-skill` session see ONE shared library. Per-session toggles
// (`sessionSkillOverrides` / `sessionSkillGroups`) are pane-local and stay store-only — they are not
// part of the global library. The persisted copy is just a fast first-paint cache; hydrate reconciles.
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import type { SkillPayload } from "@/features/planner/blueprints/blueprintSkills";
import {
  seedSkills, refreshPackagedSkills, skillFromPayload, applySessionSkillChoice, skillSlug,
  type SkillDef, type SessionSkillOverride, type SkillGroup,
} from "./lib/skills";
import { loadLibrary, pushSkill, dropSkill, pushGroup, dropGroup } from "./lib/skillBridge";
import { deleteMapEntry } from "@/store/updateHelpers";

export interface SkillsSlice {
  // Skills — reusable capability bundles (prompt + bundled tools + profile guardrails) the fleet can
  // invoke, each scoped via its `projects` ([] = global). Written into a launched session's
  // .claude/skills/<slug>/SKILL.md. Seeded from the sample library; persisted as a cache. (#404)
  skills: SkillDef[];
  /** Hydrate the library from the global skills.db on boot (#1338): load + reconcile the packaged
   *  set, then seed/refresh the db with the reconciled set. No-op (keeps the seeded set) when the
   *  bridge is unreachable — tests, the web shell, or an old binary. */
  hydrateSkills: () => Promise<void>;
  /** Lightweight re-read of the global skills.db into the cache (#1419): like {@link hydrateSkills}
   *  but WITHOUT the boot-time push-back of the whole set — cheap enough to poll while the planner
   *  runs, so skills the planner authors via `bsc-skill add` (and their session-group membership)
   *  appear live. No-op when the bridge is unreachable. */
  refreshSkills: () => Promise<void>;
  /** Reconstitute a shared blueprint's embedded skills into the library (#897 Phase 5b). */
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
  // Task groups (#skills-groups) — named, reusable skill bundles toggled as one. Persisted as a cache.
  skillGroups: SkillGroup[];
  addSkillGroup: (name: string, hue?: string) => string;
  updateSkillGroup: (id: string, patch: Partial<Omit<SkillGroup, "id">>) => void;
  removeSkillGroup: (id: string) => void;
  toggleSkillGroupMember: (groupId: string, skillId: string) => void;
  upsertSkillGroups: (groups: Array<Omit<SkillGroup, "id"> & { id?: string }>) => void;
  /** Ensure the per-project planning session group exists with a fixed `id` and the given `name`
   *  (#1419): creates it (empty) if absent, else just renames it when the project title changed —
   *  never clobbering the members the planner has paired into it. */
  ensureSessionGroup: (id: string, name: string, hue?: string) => void;
  // Per-session enabled groups, keyed by the session's stable identity id; persisted.
  sessionSkillGroups: Record<string, string[]>;
  setSessionSkillGroup: (sessionKey: string, groupId: string, on: boolean) => void;
}

export const createSkillsSlice: StateCreator<AppStore, [], [], SkillsSlice> = (set, get) => ({
  skills: seedSkills(),
  hydrateSkills: async () => {
    const lib = await loadLibrary();
    if (!lib) return; // bridge unreachable — keep the seeded in-memory set
    // Reconcile the code-owned packaged skills over whatever the db held (first run: db empty →
    // just the packaged set; later: packaged refreshed from code + the user's skills preserved).
    const skills = refreshPackagedSkills(lib.skills);
    set({ skills, skillGroups: lib.groups });
    // Seed/refresh the db with the reconciled set so first-run packaged skills + any code updates
    // persist (and a freshly-installed app populates its global library).
    for (const s of skills) void pushSkill(s);
  },
  refreshSkills: async () => {
    const lib = await loadLibrary();
    if (!lib) return; // bridge unreachable — keep the current cache
    // Re-read only; no push-back (that's hydrate's job). The db is the source of truth, and every
    // local edit already wrote through, so overwriting the cache from it can't lose anything.
    set({ skills: refreshPackagedSkills(lib.skills), skillGroups: lib.groups });
  },
  addSkill: (def) => {
    const id = `skill_${Math.random().toString(36).slice(2, 8)}`;
    const full = { ...def, id } as SkillDef;
    set((s) => ({ skills: [...s.skills, full] }));
    void pushSkill(full);
    return id;
  },
  installBundledSkills: (payloads) =>
    set((s) => {
      const haveSkill = new Set(s.skills.map((x) => x.id));
      const newSkills: SkillDef[] = [];
      for (const p of payloads) {
        if (haveSkill.has(p.id) || !p.id) continue;
        haveSkill.add(p.id);
        const def = skillFromPayload(p);
        newSkills.push(def);
        void pushSkill(def);
      }
      if (newSkills.length === 0) return {};
      return { skills: [...s.skills, ...newSkills] };
    }),
  updateSkill: (id, patch) => {
    set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, ...patch } : sk)) }));
    const updated = get().skills.find((sk) => sk.id === id);
    if (updated) void pushSkill(updated);
  },
  removeSkill: (id) => {
    set((s) => ({ skills: s.skills.filter((sk) => sk.id !== id) }));
    void dropSkill(id);
  },
  toggleSkill: (id) => {
    set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, enabled: !sk.enabled } : sk)) }));
    const updated = get().skills.find((sk) => sk.id === id);
    if (updated) void pushSkill(updated);
  },
  toggleSkillPin: (id) => {
    set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, pinned: !sk.pinned } : sk)) }));
    const updated = get().skills.find((sk) => sk.id === id);
    if (updated) void pushSkill(updated);
  },
  setSkillProjects: (id, projects) => {
    set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, projects } : sk)) }));
    const updated = get().skills.find((sk) => sk.id === id);
    if (updated) void pushSkill(updated);
  },
  upsertSkills: (defs) => {
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
    });
    // Push the resolved (post-merge) rows for the affected names so the db mirrors the store.
    const bySlug = new Map(get().skills.map((sk) => [skillSlug(sk.name), sk] as const));
    for (const def of defs) {
      const merged = bySlug.get(skillSlug(def.name));
      if (merged) void pushSkill(merged);
    }
  },
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
      return {
        sessionSkillOverrides: deleteMapEntry(s.sessionSkillOverrides, sessionKey),
        sessionSkillGroups: deleteMapEntry(s.sessionSkillGroups, sessionKey),
      };
    }),

  // ── Task groups (#skills-groups) ──────────────────────────────────────
  skillGroups: [],
  addSkillGroup: (name, hue) => {
    const id = `grp_${Math.random().toString(36).slice(2, 8)}`;
    const group: SkillGroup = { id, name, hue: hue ?? "var(--accent)", skillIds: [] };
    set((s) => ({ skillGroups: [...s.skillGroups, group] }));
    void pushGroup(group);
    return id;
  },
  updateSkillGroup: (id, patch) => {
    set((s) => ({ skillGroups: s.skillGroups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }));
    const updated = get().skillGroups.find((g) => g.id === id);
    if (updated) void pushGroup(updated);
  },
  removeSkillGroup: (id) => {
    set((s) => {
      const sessionSkillGroups: Record<string, string[]> = {};
      for (const [k, ids] of Object.entries(s.sessionSkillGroups)) {
        const kept = ids.filter((g) => g !== id);
        if (kept.length) sessionSkillGroups[k] = kept;
      }
      return { skillGroups: s.skillGroups.filter((g) => g.id !== id), sessionSkillGroups };
    });
    void dropGroup(id);
  },
  ensureSessionGroup: (id, name, hue) => {
    // Lazy session group (#1616): never PRE-CREATE. `bsc-skill add --group <id>` creates the group on
    // the planner's FIRST authored skill (placeholder name = its id, empty hue); here we only ADOPT it
    // once it exists — rename the placeholder to the project name (and on later title changes) and fill
    // the empty placeholder hue, never clobbering members or a user-set color. A project that authors
    // no skills never gets an empty group written to skills.db.
    const existing = get().skillGroups.find((g) => g.id === id);
    if (!existing) return;
    const patch: Partial<Omit<SkillGroup, "id">> = {};
    if (name && existing.name !== name) patch.name = name;
    if (!existing.hue) patch.hue = hue ?? "var(--violet)";
    if (Object.keys(patch).length > 0) get().updateSkillGroup(id, patch);
  },
  toggleSkillGroupMember: (groupId, skillId) => {
    set((s) => ({
      skillGroups: s.skillGroups.map((g) => {
        if (g.id !== groupId) return g;
        const has = g.skillIds.includes(skillId);
        return { ...g, skillIds: has ? g.skillIds.filter((x) => x !== skillId) : [...g.skillIds, skillId] };
      }),
    }));
    const updated = get().skillGroups.find((g) => g.id === groupId);
    if (updated) void pushGroup(updated);
  },
  upsertSkillGroups: (groups) => {
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
    });
    const bySlug = new Map(get().skillGroups.map((g) => [skillSlug(g.name), g] as const));
    for (const g of groups) {
      const merged = bySlug.get(skillSlug(g.name));
      if (merged) void pushGroup(merged);
    }
  },
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
