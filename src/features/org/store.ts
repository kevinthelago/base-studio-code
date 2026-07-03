// Org feature store slice (#2193) — the persona-relationship graph library, a WRITE-THROUGH cache over
// the global org store (`~/.base-studio-code/orgs/`, reached via `bsc org` — see orgBridge.ts). The
// desktop Org designer, live sessions, and the planner share ONE store. On boot `hydrateOrgs` loads
// through the bridge + reconciles the packaged built-ins; every mutation below pushes through. The
// persisted `orgs` in app-state is just a fast first-paint cache; hydrate is authoritative.
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import {
  BUILTIN_ORGS, blankOrg, orgSlug, reconcileOrgs,
  type Org, type Position, type Relationship,
} from "./lib/org";
import { loadOrgs, pushOrg, dropOrg } from "./lib/orgBridge";

export interface OrgSlice {
  /** The org library — packaged built-ins (reconciled on load) + user-authored. */
  orgs: Org[];
  /** Hydrate the library from the global org store on boot (#2193): load via the bridge, reconcile the
   *  packaged built-ins, and push any newly-seeded built-in back so the store has it. No-op (keeps the
   *  seeded set) when the bridge is unreachable — tests, the web shell, or an old binary. */
  hydrateOrgs: () => Promise<void>;
  /** Create a user org and return its new id. */
  addOrg: () => string;
  /** Clone any org (incl. a built-in) into a new editable user org; returns the new id. */
  cloneOrg: (id: string) => string;
  /** Patch an org's editable fields. Built-ins keep their builtin identity; only user orgs can be
   *  deleted. */
  updateOrg: (id: string, patch: Partial<Omit<Org, "id" | "builtin">>) => void;
  /** Remove a USER org (built-ins are not deletable — no-op). */
  removeOrg: (id: string) => void;
  /** Add a position (node) to an org. */
  addPosition: (orgId: string, position: Position) => void;
  /** Patch a position's fields (label, persona, x/y, …) by nodeId. */
  updatePosition: (orgId: string, nodeId: string, patch: Partial<Omit<Position, "nodeId">>) => void;
  /** Remove a position and every relationship touching it. */
  removePosition: (orgId: string, nodeId: string) => void;
  /** Add a relationship edge to an org. */
  addRelationship: (orgId: string, relationship: Relationship) => void;
  /** Patch a relationship (e.g. change its archetype) by id. */
  updateRelationship: (orgId: string, relationshipId: string, patch: Partial<Omit<Relationship, "id">>) => void;
  /** Remove a relationship by id. */
  removeRelationship: (orgId: string, relationshipId: string) => void;
}

/** Mint a fresh, collision-free user-org id from a name (or a generic seed). */
function mintOrgId(existing: Org[], name: string): string {
  const base = `org-${orgSlug(name)}`;
  if (!existing.some((o) => o.id === base)) return base;
  let n = 2;
  while (existing.some((o) => o.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export const createOrgSlice: StateCreator<AppStore, [], [], OrgSlice> = (set, get) => {
  /** Patch one org in place, push the result through the bridge. Central so every mutation converges. */
  const mutate = (id: string, fn: (o: Org) => Org) => {
    let updated: Org | undefined;
    set((s) => ({
      orgs: s.orgs.map((o) => {
        if (o.id !== id) return o;
        updated = fn(o);
        return updated;
      }),
    }));
    if (updated) void pushOrg(updated);
  };

  return {
    orgs: BUILTIN_ORGS,

    hydrateOrgs: async () => {
      const loaded = await loadOrgs();
      if (!loaded) return; // bridge unreachable — keep the seeded built-ins
      const reconciled = reconcileOrgs(loaded);
      set({ orgs: reconciled });
      // Persist any built-in the store didn't have yet (first run / a new packaged org), so the store —
      // the source of truth a session/planner reads — carries the full library.
      const had = new Set(loaded.map((o) => o.id));
      for (const o of reconciled) if (!had.has(o.id)) void pushOrg(o);
    },

    addOrg: () => {
      const id = mintOrgId(get().orgs, "new org");
      const org = blankOrg(id);
      set((s) => ({ orgs: [...s.orgs, org] }));
      void pushOrg(org);
      return id;
    },

    cloneOrg: (id) => {
      const src = get().orgs.find((o) => o.id === id);
      if (!src) return id;
      const name = `${src.name} copy`;
      const newId = mintOrgId(get().orgs, name);
      const clone: Org = { ...src, id: newId, name, builtin: false };
      set((s) => ({ orgs: [...s.orgs, clone] }));
      void pushOrg(clone);
      return newId;
    },

    updateOrg: (id, patch) => mutate(id, (o) => ({ ...o, ...patch, id: o.id, builtin: o.builtin })),

    removeOrg: (id) => {
      const target = get().orgs.find((o) => o.id === id);
      if (!target || target.builtin) return; // built-ins are not deletable
      set((s) => ({ orgs: s.orgs.filter((o) => o.id !== id) }));
      void dropOrg(id);
    },

    addPosition: (orgId, position) =>
      mutate(orgId, (o) => ({ ...o, positions: [...o.positions, position] })),

    updatePosition: (orgId, nodeId, patch) =>
      mutate(orgId, (o) => ({
        ...o,
        positions: o.positions.map((p) => (p.nodeId === nodeId ? { ...p, ...patch, nodeId: p.nodeId } : p)),
      })),

    removePosition: (orgId, nodeId) =>
      mutate(orgId, (o) => ({
        ...o,
        positions: o.positions.filter((p) => p.nodeId !== nodeId),
        // Drop every edge that touched the removed node so the graph stays well-formed.
        relationships: o.relationships.filter((r) => r.from !== nodeId && r.to !== nodeId),
      })),

    addRelationship: (orgId, relationship) =>
      mutate(orgId, (o) => ({ ...o, relationships: [...o.relationships, relationship] })),

    updateRelationship: (orgId, relationshipId, patch) =>
      mutate(orgId, (o) => ({
        ...o,
        relationships: o.relationships.map((r) => (r.id === relationshipId ? { ...r, ...patch, id: r.id } : r)),
      })),

    removeRelationship: (orgId, relationshipId) =>
      mutate(orgId, (o) => ({ ...o, relationships: o.relationships.filter((r) => r.id !== relationshipId) })),
  };
};
