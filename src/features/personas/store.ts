// Personas feature store slice (#2094) — the CRUD-able agent-identity library. Composed into the app
// store by store/index.ts and persisted (the built-ins are re-seeded + reconciled on load via
// `reconcilePersonas`, so a new packaged persona appears and user edits survive). Behavior identity
// only: the ROLE it references (permissions) lives in `sessionRoles.ts` and is never mutated here.
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import type { SessionRole } from "@/shared/lib/session/sessionRoles";
import { BUILTIN_PERSONAS, blankPersona, personaSlug, type Persona } from "./lib/persona";

export interface PersonasSlice {
  /** The persona library — packaged built-ins (reconciled on load) + user-authored. */
  personas: Persona[];
  /** Create a user persona (optionally on a given role) and return its new id. */
  addPersona: (role?: SessionRole) => string;
  /** Clone any persona (incl. a built-in) into a new editable user persona; returns the new id. */
  clonePersona: (id: string) => string;
  /** Patch a persona's editable fields (name/blurb/prompt/skills/model/role). Built-ins keep their
   *  builtin identity; only user personas can be deleted. */
  updatePersona: (id: string, patch: Partial<Omit<Persona, "id" | "builtin">>) => void;
  /** Remove a USER persona (built-ins are not deletable — no-op). */
  removePersona: (id: string) => void;
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

  addPersona: (role = "reviewer") => {
    const id = mintPersonaId(get().personas, "new persona");
    set((s) => ({ personas: [...s.personas, blankPersona(id, role)] }));
    return id;
  },

  clonePersona: (id) => {
    const src = get().personas.find((p) => p.id === id);
    if (!src) return id;
    const name = `${src.name} copy`;
    const newId = mintPersonaId(get().personas, name);
    const clone: Persona = { ...src, id: newId, name, builtin: false };
    set((s) => ({ personas: [...s.personas, clone] }));
    return newId;
  },

  updatePersona: (id, patch) =>
    set((s) => ({
      personas: s.personas.map((p) =>
        p.id === id ? { ...p, ...patch, id: p.id, builtin: p.builtin } : p,
      ),
    })),

  removePersona: (id) =>
    set((s) => ({
      personas: s.personas.filter((p) => !(p.id === id && !p.builtin)),
    })),
});
