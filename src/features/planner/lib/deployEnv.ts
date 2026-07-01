// Per-service deploy building blocks (#919; per-repo rework #1421; local mode #1192) — the
// environment ladder, CI/CD pipeline, config/secrets block, release policy, and health policy that
// each DeployService owns, plus the ship-mode option lists and the sensible default a fresh service
// starts from.
//
// The DATA (option lists + defaults) is externalized to `@data/deploy/taxonomy.json` (#2027 P1) —
// the single source, editable without touching code and part of the exportable app-config bundle.
// This module keeps only the TYPES + the accessor/const names + the default BUILDERS (which return a
// fresh deep copy of the JSON default each call, since callers mutate them). Pure (no React/Tauri).

import taxonomy from "@data/deploy/taxonomy.json";

/** How a service ships (#1192). `cloud` = a hosted platform; `local` = a published library or a
 *  build-and-run-here application (CLI / desktop / local server). A monorepo can mix the two. */
export type DeployMode = "cloud" | "local";
/** A local service is either a published library or a built application (#1192). */
export type LocalKind = "library" | "application";

/** Package registries a local LIBRARY can publish to (#1192). */
export type PublishRegistry = "npm" | "crates.io" | "PyPI" | "internal";
export const PUBLISH_REGISTRIES = taxonomy.publishRegistries as readonly PublishRegistry[];
/** When a library's publish workflow fires (#1192). */
export type PublishTrigger = "on-tag" | "manual";
export const PUBLISH_TRIGGERS = taxonomy.publishTriggers as readonly PublishTrigger[];

/** How a locally-running deployment is exposed remotely (#1192). `cloudflared` is the default —
 *  we already run a Cloudflare relay for the mobile tunnel. */
export type PortForwardMethod = "cloudflared" | "ngrok" | "tailscale" | "LAN";
export const PORT_FORWARD_METHODS = taxonomy.portForwardMethods as readonly PortForwardMethod[];

/** Optional remote exposure for a local Application / server (#1192). */
export interface PortForward {
  enabled: boolean;
  /** Port to expose (string so the field stays free-form, e.g. "8080"). */
  port: string;
  method: PortForwardMethod;
}

export interface DeployEnvironment {
  id: string;
  name: string;
  branch: string;
  url: string;
  /** Auto-deploy on push to `branch` (vs manual promotion). */
  auto: boolean;
  proposed?: boolean;
}

export type PipeTrigger = "push" | "tag" | "on-green" | "manual";
export const PIPE_TRIGGERS = taxonomy.pipeTriggers as PipeTrigger[];

export interface PipelineStage {
  id: string;
  name: string;
  trigger: PipeTrigger;
  /** Blocks promotion until green. */
  gate: boolean;
  cmd: string;
}
export interface Pipeline {
  provider: string;
  stages: PipelineStage[];
}

export interface DeployConfigRow { key: string; [env: string]: string }
export interface DeploySecretRow { key: string; [env: string]: boolean | string }
export interface DeployConfigBlock {
  config: DeployConfigRow[];
  /** Secrets are tracked by NAME + per-env "wired" flag — values never live here. */
  secrets: DeploySecretRow[];
  vault: string;
}

export type ReleaseStrategy = "recreate" | "rolling" | "blue-green" | "canary";
export const RELEASE_STRATEGIES = taxonomy.releaseStrategies as { id: ReleaseStrategy; label: string; desc: string }[];
export interface ReleasePolicy {
  /** The rollout/release strategy. {@link RELEASE_STRATEGIES} are the KNOWN cloud-rollout options the
   *  picker offers, but the field accepts ANY non-empty string — a release-artifact deploy (GitHub
   *  Pages/Releases, npm publish, packaging) legitimately carries a free-text strategy like
   *  `github-release (tag on main → …)` that isn't one of the four. `""` = unset. */
  strategy: string;
  autoRollback: boolean;
  keep: number;
  migrateWithDeploy: boolean;
}

export interface HealthPolicy {
  probe: string; probeOn: boolean;
  slo: string; sloOn: boolean;
  alerts: string; alertsOn: boolean;
}

// The sensible defaults a fresh service's deploy plan starts from (from `@data/deploy/taxonomy.json`).
// Each builder returns a fresh DEEP COPY so callers can mutate their service's config independently.
const clone = <T>(v: T): T => structuredClone(v);

/** A sensible default environment ladder a repo's deploy plan starts from. */
export function defaultEnvs(): DeployEnvironment[] {
  return clone(taxonomy.defaults.envs) as DeployEnvironment[];
}
/** A sensible default pipeline a repo's deploy plan starts from. */
export function defaultPipeline(): Pipeline {
  return clone(taxonomy.defaults.pipeline) as Pipeline;
}
export function defaultRelease(): ReleasePolicy {
  return clone(taxonomy.defaults.release) as ReleasePolicy;
}
export function defaultHealth(): HealthPolicy {
  return clone(taxonomy.defaults.health) as HealthPolicy;
}
