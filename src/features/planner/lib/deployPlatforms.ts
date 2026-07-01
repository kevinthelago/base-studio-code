// Deploy target catalog (#919; per-repo rework #1421) — the platforms a service can ship to, the
// workload kinds, the git hosts a repo can live on, and the container orchestration options.
//
// The DATA is externalized to `@data/deploy/taxonomy.json` (#2027 P1) — the single source, editable
// without touching code and part of the exportable app-config bundle. This module keeps only the
// TYPES + accessor helpers over that data (no React/Tauri, so it stays unit-testable).

import taxonomy from "@data/deploy/taxonomy.json";

/** Workload kind a service deploys as. */
export type Workload = "static" | "serverless" | "container" | "service";

export interface DeployPlatform {
  id: string;
  name: string;
  /** Workload kinds this platform supports. */
  kinds: Workload[];
  /** oklch hue for the platform tile glyph. */
  h: number;
  glyph: string;
}

/** Platform catalog — the deploy targets a service can pick (from `@data/deploy/taxonomy.json`). */
export const PLATFORMS: DeployPlatform[] = taxonomy.platforms as DeployPlatform[];

export function platform(id: string): DeployPlatform {
  return PLATFORMS.find((p) => p.id === id) ?? { id, name: id, h: 250, glyph: "■", kinds: [] };
}

export const WORKLOAD: Record<Workload, { label: string; c: string }> =
  taxonomy.workloads as Record<Workload, { label: string; c: string }>;

/** A git host a project's repos can live on — a project may span clouds or a self-hosted server. */
export interface GitHost { key: string; domain: string; label: string; kind: "cloud" | "self-hosted"; color: string }
export const HOSTS: Record<string, GitHost> = taxonomy.gitHosts as Record<string, GitHost>;
export function hostMeta(id: string | undefined): GitHost {
  return HOSTS[id ?? "github"] ?? HOSTS.github;
}

/** Orchestrators a distributed (container) workload can run under. */
export const ORCHESTRATORS: { id: string; label: string }[] = taxonomy.orchestrators;
/** Replica-count options for a container workload (string so "auto" fits the same control). */
export const REPLICA_OPTIONS: readonly string[] = taxonomy.replicaOptions;
