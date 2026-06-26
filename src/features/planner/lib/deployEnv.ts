// Per-service deploy building blocks (#919; per-repo rework #1421; local mode #1192) — the
// environment ladder, CI/CD pipeline, config/secrets block, release policy, and health policy that
// each DeployService owns, plus the local-vs-cloud ship-mode option lists and the sensible default
// builders a fresh service starts from. Pure data (no React/Tauri). Split out of deployConfig.ts (#1639).

/** How a service ships (#1192). `cloud` = a hosted platform; `local` = a published library or a
 *  build-and-run-here application (CLI / desktop / local server). A monorepo can mix the two. */
export type DeployMode = "cloud" | "local";
/** A local service is either a published library or a built application (#1192). */
export type LocalKind = "library" | "application";

/** Package registries a local LIBRARY can publish to (#1192). */
export const PUBLISH_REGISTRIES = ["npm", "crates.io", "PyPI", "internal"] as const;
export type PublishRegistry = (typeof PUBLISH_REGISTRIES)[number];
/** When a library's publish workflow fires (#1192). */
export const PUBLISH_TRIGGERS = ["on-tag", "manual"] as const;
export type PublishTrigger = (typeof PUBLISH_TRIGGERS)[number];

/** How a locally-running deployment is exposed remotely (#1192). `cloudflared` is the default —
 *  we already run a Cloudflare relay for the mobile tunnel. */
export const PORT_FORWARD_METHODS = ["cloudflared", "ngrok", "tailscale", "LAN"] as const;
export type PortForwardMethod = (typeof PORT_FORWARD_METHODS)[number];

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
export const PIPE_TRIGGERS: PipeTrigger[] = ["push", "tag", "on-green", "manual"];

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
export const RELEASE_STRATEGIES: { id: ReleaseStrategy; label: string; desc: string }[] = [
  { id: "recreate",   label: "recreate",   desc: "Stop old, start new — brief downtime." },
  { id: "rolling",    label: "rolling",    desc: "Replace instances incrementally." },
  { id: "blue-green", label: "blue-green", desc: "Stand up new, flip traffic, keep old warm." },
  { id: "canary",     label: "canary",     desc: "Shift a % of traffic, watch, then ramp." },
];
export interface ReleasePolicy {
  strategy: ReleaseStrategy | "";
  autoRollback: boolean;
  keep: number;
  migrateWithDeploy: boolean;
}

export interface HealthPolicy {
  probe: string; probeOn: boolean;
  slo: string; sloOn: boolean;
  alerts: string; alertsOn: boolean;
}

/** A sensible default environment ladder a repo's deploy plan starts from. */
export function defaultEnvs(): DeployEnvironment[] {
  return [
    { id: "dev",     name: "dev",     branch: "feature/*", url: "", auto: true,  proposed: true },
    { id: "staging", name: "staging", branch: "develop",   url: "", auto: true,  proposed: true },
    { id: "prod",    name: "prod",    branch: "main",       url: "", auto: false, proposed: true },
  ];
}
/** A sensible default pipeline a repo's deploy plan starts from. */
export function defaultPipeline(): Pipeline {
  return {
    provider: "GitHub Actions",
    stages: [
      { id: "build",  name: "build",  trigger: "push",     gate: false, cmd: "" },
      { id: "test",   name: "test",   trigger: "on-green", gate: true,  cmd: "" },
      { id: "deploy", name: "deploy", trigger: "on-green", gate: false, cmd: "" },
    ],
  };
}
export function defaultRelease(): ReleasePolicy {
  return { strategy: "", autoRollback: true, keep: 3, migrateWithDeploy: false };
}
export function defaultHealth(): HealthPolicy {
  return { probe: "/healthz", probeOn: false, slo: "", sloOn: false, alerts: "", alertsOn: false };
}
