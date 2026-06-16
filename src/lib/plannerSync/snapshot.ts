// Per-project base-snapshot persistence for the planner-sync reconcile loop.
//
// The base snapshot is the last manifest the desktop transmitted to mobile.
// On reconnect, the desktop diffs its current manifest against the base snapshot
// to decide which local changes are "new" (and should be announced) vs. already
// known. Stored in localStorage keyed by stable projectId.

import type { PlanManifest } from "../plannerCore/types";

function storageKey(projectId: string): string {
  return `planner-sync:snapshot:${projectId}`;
}

/** Load the persisted base snapshot for a project. Returns null if none exists. */
export function loadSnapshot(projectId: string): PlanManifest | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(storageKey(projectId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.projectId !== "string" || !o.projectId) return null;
    if (!o.files || typeof o.files !== "object" || Array.isArray(o.files)) return null;
    return v as PlanManifest;
  } catch { return null; }
}

/** Persist the base snapshot for a project. */
export function saveSnapshot(manifest: PlanManifest): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(storageKey(manifest.projectId), JSON.stringify(manifest));
}

/** Remove the base snapshot (e.g. after a fresh full-sync or project deletion). */
export function clearSnapshot(projectId: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(storageKey(projectId));
}
