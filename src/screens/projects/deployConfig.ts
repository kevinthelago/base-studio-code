// Deployment & infrastructure config (#919) — the data model behind the planner's Deploy stage
// (right after Repos). Pure (no React/Tauri) so the readiness checks that drive the stage gate
// are unit-testable. Ported from design/bsc project planner focused/planner.
//
// One DeployConfig per project (store slice `planDeployConfig`). The Deploy pane edits it; the
// `deploymentDefined` gate signal (planStageDerive) is `deployChecks(config).every(ok)`.

import { repoShortName } from "../../lib/projectPaths";

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

/** Platform catalog — the deploy targets a service can pick. */
export const PLATFORMS: DeployPlatform[] = [
  { id: "vercel",     name: "Vercel",             kinds: ["static", "serverless"], h: 250, glyph: "▲" },
  { id: "netlify",    name: "Netlify",            kinds: ["static", "serverless"], h: 195, glyph: "◆" },
  { id: "cloudflare", name: "Cloudflare",         kinds: ["static", "serverless"], h: 70,  glyph: "☁" },
  { id: "fly",        name: "Fly.io",             kinds: ["container", "service"], h: 300, glyph: "✦" },
  { id: "railway",    name: "Railway",            kinds: ["container", "service"], h: 300, glyph: "◇" },
  { id: "render",     name: "Render",             kinds: ["container", "service"], h: 230, glyph: "◉" },
  { id: "aws",        name: "AWS",                kinds: ["serverless", "container", "service"], h: 70,  glyph: "❯" },
  { id: "gcp",        name: "GCP",                kinds: ["serverless", "container", "service"], h: 230, glyph: "◐" },
  { id: "azure",      name: "Azure",             kinds: ["serverless", "container", "service"], h: 250, glyph: "◭" },
  { id: "ghpages",    name: "GitHub Pages",       kinds: ["static"], h: 250, glyph: "⎇" },
  { id: "docker",     name: "Self-host · Docker", kinds: ["container"], h: 230, glyph: "⬢" },
  { id: "k8s",        name: "Self-host · K8s",    kinds: ["container", "service"], h: 230, glyph: "⎈" },
];
export function platform(id: string): DeployPlatform {
  return PLATFORMS.find((p) => p.id === id) ?? { id, name: id, h: 250, glyph: "■", kinds: [] };
}

export const WORKLOAD: Record<Workload, { label: string; c: string }> = {
  static:     { label: "static",       c: "var(--info)" },
  serverless: { label: "serverless",   c: "var(--accent)" },
  container:  { label: "container",    c: "var(--violet)" },
  service:    { label: "long-running", c: "var(--success)" },
};

/** A deployable unit — one per linked repo (or sub-path). */
export interface DeployService {
  id: string;
  repo: string;
  path: string;
  stack: string;
  platform: string;
  workload: Workload;
  /** True until the user accepts/edits the planner's proposed target. */
  proposed: boolean;
  region: string;
  build: string;
  output: string;
  runtime: string;
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

export interface DeployConfig {
  /** The service tab currently selected in the pane. */
  selService: string;
  services: DeployService[];
  envs: DeployEnvironment[];
  pipeline: Pipeline;
  config: DeployConfigBlock;
  release: ReleasePolicy;
  health: HealthPolicy;
}

/** Seed a config for a project from its linked repos — one proposed service per repo, plus a
 *  sensible default environment ladder / pipeline / release / health the planner can refine. */
export function defaultDeployConfig(repos: string[]): DeployConfig {
  const services: DeployService[] = (repos.length ? repos : [""]).map((repo) => {
    const short = repo ? repoShortName(repo) : "app";
    return {
      id: short, repo, path: ".", stack: "—",
      platform: "", workload: "static", proposed: true,
      region: "—", build: "—", output: "dist", runtime: "—",
    };
  });
  return {
    selService: services[0]?.id ?? "",
    services,
    envs: [
      { id: "dev",     name: "dev",     branch: "feature/*", url: "", auto: true,  proposed: true },
      { id: "staging", name: "staging", branch: "develop",   url: "", auto: true,  proposed: true },
      { id: "prod",    name: "prod",    branch: "main",       url: "", auto: false, proposed: true },
    ],
    pipeline: {
      provider: "GitHub Actions",
      stages: [
        { id: "build",  name: "build",  trigger: "push",     gate: false, cmd: "" },
        { id: "test",   name: "test",   trigger: "on-green", gate: true,  cmd: "" },
        { id: "deploy", name: "deploy", trigger: "on-green", gate: false, cmd: "" },
      ],
    },
    config: { config: [], secrets: [], vault: "host vault" },
    release: { strategy: "", autoRollback: true, keep: 3, migrateWithDeploy: false },
    health: { probe: "/healthz", probeOn: false, slo: "", sloOn: false, alerts: "", alertsOn: false },
  };
}

export interface DeployCheck { id: string; label: string; ok: boolean; detail: string }

/** The readiness checks that drive the stage gate — every one `ok` ⇒ the gate is met. */
export function deployChecks(d: DeployConfig): DeployCheck[] {
  const prodSecrets = d.config.secrets.length === 0 || d.config.secrets.every((s) => !!s.prod);
  return [
    { id: "target",   label: "Deploy target per service", ok: d.services.length > 0 && d.services.every((s) => !!s.platform), detail: `${d.services.filter((s) => s.platform).length}/${d.services.length} services` },
    { id: "envs",     label: "Environment ladder defined", ok: d.envs.length >= 2, detail: `${d.envs.length} environments` },
    { id: "pipeline", label: "CI/CD pipeline staged",      ok: d.pipeline.stages.length >= 2, detail: d.pipeline.provider },
    { id: "secrets",  label: "Secrets wired for every env", ok: prodSecrets, detail: prodSecrets ? "all set" : "missing prod" },
    { id: "release",  label: "Release & rollback strategy", ok: !!d.release.strategy, detail: d.release.strategy || "—" },
  ];
}

/** The `deploymentDefined` gate signal: every readiness check passes. */
export function deploymentDefined(d: DeployConfig | undefined): boolean {
  return !!d && deployChecks(d).every((c) => c.ok);
}
