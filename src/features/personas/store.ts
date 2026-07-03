// Personas feature store slice (#2094) — the CRUD-able agent-identity library, a WRITE-THROUGH cache
// over the global persona store (`~/.base-studio-code/personas/`, reached via `bsc persona` — see
// personaBridge.ts). The desktop UI, live sessions, and the planner share ONE store. On boot
// `hydratePersonas` loads through the bridge + reconciles the packaged built-ins; every mutation below
// pushes through. The persisted `personas` in app-state is just a fast first-paint cache; hydrate is
// authoritative. Behavior identity only: the ROLE it references (permissions) lives in `sessionRoles.ts`.
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import type { SessionRole } from "@/shared/lib/session/sessionRoles";
import type { ModelId } from "@/app/console/lib/models";
import { BUILTIN_PERSONAS, blankPersona, personaSlug, reconcilePersonas, type Persona } from "./lib/persona";
import { loadPersonas, pushPersona, dropPersona } from "./lib/personaBridge";

export interface PersonasSlice {
  /** The persona library — packaged built-ins (reconciled on load) + user-authored. */
  personas: Persona[];
  /** Hydrate the library from the global persona store on boot (#2094): load via the bridge, reconcile
   *  the packaged built-ins, and push any newly-seeded built-in back so the store has it. No-op (keeps
   *  the seeded set) when the bridge is unreachable — tests, the web shell, or an old binary. */
  hydratePersonas: () => Promise<void>;
  /** Create a user persona (optionally on a given role) and return its new id. */
  addPersona: (role?: SessionRole) => string;
  /** Clone any persona (incl. a built-in) into a new editable user persona; returns the new id. */
  clonePersona: (id: string) => string;
  /** Patch a persona's editable fields (name/blurb/prompt/skills/model/role). Built-ins keep their
   *  builtin identity; only user personas can be deleted. */
  updatePersona: (id: string, patch: Partial<Omit<Persona, "id" | "builtin">>) => void;
  /** Remove a USER persona (built-ins are not deletable — no-op). */
  removePersona: (id: string) => void;
  /** Adopt a persona onto a console PANE (#2094 wire-up): stamp its role (the permission floor),
   *  model, and start prompt onto the pane so the pane's NEXT launch runs as that persona, and mark
   *  perms stale so the "relaunch to apply" nudge shows. Skills are attached to the persona but not
   *  applied here yet (the per-session skill-override path is a refinement). No-op for an unknown id. */
  applyPersonaToPane: (paneId: string, personaId: string) => void;
}

/** Mint a fresh, collision-free user-persona id from a name (or a generic seed). */
function mintPersonaId(existing: Persona[], name: string): string {
  const base = `persona-${personaSlug(name)}`;
  if (!existing.some((p) => p.id === base)) return base;
  let n = 2;
  while (existing.some((p) => p.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export const createPersonasSlice: StateCreator<AppStore, [], [], PersonasSlice> = (set, get) => ({
  personas: BUILTIN_PERSONAS,

  hydratePersonas: async () => {
    const loaded = await loadPersonas();
    if (!loaded) return; // bridge unreachable — keep the seeded built-ins
    const reconciled = reconcilePersonas(loaded);
    set({ personas: reconciled });
    // Converge the store — the source of truth a session/planner reads — with the reconciled library.
    // Push a built-in that the store lacks (first run / a newly-packaged persona) OR whose stored copy
    // drifted from the packaged prose (the #2185 upgrade path: worker/director seeded empty by an older
    // app now carry their real fleet protocol). User edits are preserved by reconcile, so only genuine
    // drift re-pushes.
    const loadedById = new Map(loaded.map((p) => [p.id, p]));
    for (const p of reconciled) {
      const before = loadedById.get(p.id);
      if (!before || (p.builtin && before.startPrompt !== p.startPrompt)) void pushPersona(p);
    }
  },

  addPersona: (role = "reviewer") => {
    const id = mintPersonaId(get().personas, "new persona");
    const persona = blankPersona(id, role);
    set((s) => ({ personas: [...s.personas, persona] }));
    void pushPersona(persona);
    return id;
  },

  clonePersona: (id) => {
    const src = get().personas.find((p) => p.id === id);
    if (!src) return id;
    const name = `${src.name} copy`;
    const newId = mintPersonaId(get().personas, name);
    const clone: Persona = { ...src, id: newId, name, builtin: false };
    set((s) => ({ personas: [...s.personas, clone] }));
    void pushPersona(clone);
    return newId;
  },

  updatePersona: (id, patch) => {
    let updated: Persona | undefined;
    set((s) => ({
      personas: s.personas.map((p) => {
        if (p.id !== id) return p;
        updated = { ...p, ...patch, id: p.id, builtin: p.builtin };
        return updated;
      }),
    }));
    if (updated) void pushPersona(updated);
  },

  removePersona: (id) => {
    const target = get().personas.find((p) => p.id === id);
    if (!target || target.builtin) return; // built-ins are not deletable
    set((s) => ({ personas: s.personas.filter((p) => p.id !== id) }));
    void dropPersona(id);
  },

  applyPersonaToPane: (paneId, personaId) => {
    const persona = get().personas.find((p) => p.id === personaId);
    if (!persona) return;
    set((s) => ({
      paneRoles: { ...s.paneRoles, [paneId]: persona.role },
      paneModels: persona.model ? { ...s.paneModels, [paneId]: persona.model as ModelId } : s.paneModels,
      paneStartupPromptText: persona.startPrompt
        ? { ...s.paneStartupPromptText, [paneId]: persona.startPrompt }
        : s.paneStartupPromptText,
      // Settings.json (the role gate) is read at session start — flag the pane so it shows the
      // "relaunch to apply" nudge, exactly like a profile edit (#799).
      panePermsStale: { ...s.panePermsStale, [paneId]: true },
    }));
  },
});
