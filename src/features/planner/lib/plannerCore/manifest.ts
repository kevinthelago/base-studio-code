import { fnv1a32hex } from "./hash";
import type { CanonicalFile, PlanManifest } from "./types";

/** Build a manifest from a list of canonical files (order-independent). */
export function buildManifest(projectId: string, files: CanonicalFile[]): PlanManifest {
  const map: Record<string, string> = {};
  for (const f of files) {
    map[f.relpath] = fnv1a32hex(f.content);
  }
  return { projectId, files: map };
}

export interface ManifestDiff {
  /**
   * Relpaths where the remote differs from (or is absent in) the local manifest.
   * These are the files the local peer should request from remote to catch up.
   */
  pull: string[];
  /** Relpaths present only in the local manifest (remote doesn't have them yet). */
  localOnly: string[];
}

/**
 * Diff two manifests to find which files need to move in each direction.
 * `pull` = files to request from remote (changed or absent locally).
 * `localOnly` = files present locally but absent in remote.
 * Both lists are sorted for determinism.
 */
export function diffManifests(local: PlanManifest, remote: PlanManifest): ManifestDiff {
  const pull: string[] = [];
  const localOnly: string[] = [];
  const localSet = new Set(Object.keys(local.files));

  for (const [relpath, remoteHash] of Object.entries(remote.files)) {
    if (local.files[relpath] !== remoteHash) pull.push(relpath);
    localSet.delete(relpath);
  }
  for (const relpath of localSet) localOnly.push(relpath);

  return { pull: pull.sort(), localOnly: localOnly.sort() };
}
