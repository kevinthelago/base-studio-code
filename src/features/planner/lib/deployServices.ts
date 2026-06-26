// The deployable-unit model (#919; per-repo rework #1421; local mode #1192) — one DeployService per
// linked repo, the project-wide DeployConfig that aggregates them, the readiness checks that drive
// the stage gate, the default/normalize seeders, and the `stream:deploy` issue preview. Pure (no
// React/Tauri) so the gate logic is unit-testable. Split out of deployConfig.ts (#1639).
//
// One DeployConfig per project (store slice `planDeployConfig`) holding ONE DeployService per linked
// repo. Each service is a fully self-contained deployable unit — it owns its OWN environments,
// pipeline, config/secrets, release, and health. The `deploymentDefined` gate signal is
// `services.length > 0 && services.every(serviceReady)`; the pane shows "N of M repos deploy-ready".

import { repoShortName } from "@/shared/lib/core/projectPaths";
import type { ReadinessCheck } from "./readiness";
import { platform, WORKLOAD, type Workload } from "./deployPlatforms";
import {
  defaultEnvs, defaultPipeline, defaultRelease, defaultHealth,
  type DeployEnvironment, type Pipeline, type DeployConfigBlock,
  type ReleasePolicy, type HealthPolicy,
  type DeployMode, type LocalKind, type PublishRegistry, type PublishTrigger, type PortForward,
} from "./deployEnv";

/** A deployable unit — one per linked repo (or sub-path). Each owns its OWN environments, pipeline,
 *  config/secrets, release, and health (#1421): every repo is a self-contained deployable unit. */
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
  /** Git host the repo lives on (key into {@link HOSTS}) — display only; defaults to github. */
  host?: string;
  /** Container image registry for a container workload. Absent ⇒ derived `ghcr.io/<repo>`. */
  registry?: string;
  /** Orchestrator id for a distributed container workload (see {@link ORCHESTRATORS}). */
  orchestrator?: string;
  /** Replica count for a container workload — a {@link REPLICA_OPTIONS} value ("auto" allowed). */
  replicas?: string;
  // ── Local mode (#1192) — a library or a build-and-run-here app. Absent `mode` ⇒ "cloud". ──
  /** Whether the service ships to a cloud platform or as a local artifact. Defaults to "cloud". */
  mode?: DeployMode;
  /** For a local service: library (published) vs application (built + run). */
  localKind?: LocalKind;
  /** Library: the registry it publishes to. */
  publishRegistry?: PublishRegistry;
  /** Library: the published package name. */
  packageName?: string;
  /** Library: when the publish workflow fires. */
  publishTrigger?: PublishTrigger;
  /** Application: target platform(s) to build for (OS/arch or "desktop installer"). */
  buildTargets?: string;
  /** Application: the produced artifact (e.g. a binary or installer name). */
  artifact?: string;
  /** Application: how to run the built artifact. */
  runCmd?: string;
  /** Optional remote exposure for a locally-running application. */
  portForward?: PortForward;
  // ── Per-repo deploy plan (#1421) — every repo carries its own full ship config. ──
  envs: DeployEnvironment[];
  pipeline: Pipeline;
  config: DeployConfigBlock;
  release: ReleasePolicy;
  health: HealthPolicy;
}

/** Default mode for a service whose `mode` is unset (legacy configs) — cloud. */
export function serviceMode(s: DeployService): DeployMode {
  return s.mode ?? "cloud";
}

/** A local service's `target` check passes once its mode-appropriate fields are set: a library needs
 *  a publish registry + package name; an application needs build targets + an artifact (#1192). */
export function localTargetDefined(s: DeployService): boolean {
  if (s.localKind === "library") return !!s.publishRegistry && !!(s.packageName && s.packageName.trim());
  if (s.localKind === "application") return !!(s.buildTargets && s.buildTargets.trim()) && !!(s.artifact && s.artifact.trim());
  return false;
}

/** A service has a defined deploy target — a cloud platform, or its local fields (#1192). */
export function serviceTargetDefined(s: DeployService): boolean {
  return serviceMode(s) === "local" ? localTargetDefined(s) : !!s.platform;
}

export interface DeployConfig {
  services: DeployService[];
}

/** Seed one proposed service (deployable unit) for a repo, with its own env ladder / pipeline /
 *  config / release / health the planner can refine. */
export function defaultService(repo: string): DeployService {
  const short = repo ? repoShortName(repo) : "app";
  return {
    id: short, repo, path: ".", stack: "—",
    platform: "", workload: "static", proposed: true,
    region: "—", build: "—", output: "dist", runtime: "—", host: "github",
    mode: "cloud",
    envs: defaultEnvs(),
    pipeline: defaultPipeline(),
    config: { config: [], secrets: [], vault: "host vault" },
    release: defaultRelease(),
    health: defaultHealth(),
  };
}

/** Seed a config for a project from its linked repos — one proposed service per repo. */
export function defaultDeployConfig(repos: string[]): DeployConfig {
  return { services: (repos.length ? repos : [""]).map(defaultService) };
}

/** Backfill a possibly-OLD-shape config (#1421/#1425 migration). Pre-rework configs kept `envs` /
 *  `pipeline` / `config` / `release` / `health` at the TOP level (shared across services); the
 *  per-repo rework moved them ONTO each service. A persisted old config therefore has services with
 *  none of those fields, and the per-service readers (`serviceChecks` → `s.config.secrets`) crash on
 *  it. Ensure every service owns its sub-configs — from the service, else the legacy top-level, else
 *  the defaults — and drop the `undefined`/empty case to a fresh config. Self-heals on the next save. */
export function normalizeDeployConfig(d: DeployConfig | undefined, repos: string[] = []): DeployConfig {
  if (!d || !Array.isArray(d.services) || d.services.length === 0) return defaultDeployConfig(repos);
  const legacy = d as Partial<{ envs: DeployEnvironment[]; pipeline: Pipeline; config: DeployConfigBlock; release: ReleasePolicy; health: HealthPolicy }>;
  return {
    services: d.services.map((s) => ({
      ...s,
      envs: Array.isArray(s.envs) ? s.envs : (legacy.envs ?? defaultEnvs()),
      pipeline: s.pipeline?.stages ? s.pipeline : (legacy.pipeline ?? defaultPipeline()),
      config: s.config?.secrets ? s.config : (legacy.config ?? { config: [], secrets: [], vault: "host vault" }),
      release: s.release && s.release.strategy !== undefined ? s.release : (legacy.release ?? defaultRelease()),
      health: s.health ?? legacy.health ?? defaultHealth(),
    })),
  };
}

/** The pipeline's final stage label adapts to a service's mode (#1192): cloud ships (`deploy`), a
 *  library publishes (`publish`), a local app packages (`package`). The gating `test` stays put. */
export function finalStageName(s: DeployService | undefined): "deploy" | "publish" | "package" {
  if (s && serviceMode(s) === "local") return s.localKind === "library" ? "publish" : "package";
  return "deploy";
}

/** The readiness checks for ONE service (repo) — every one `ok` ⇒ this repo is deploy-ready. */
export function serviceChecks(s: DeployService): ReadinessCheck[] {
  const prodSecrets = s.config.secrets.length === 0 || s.config.secrets.every((row) => !!row.prod);
  return [
    { id: "target",   label: "Deploy target set",          ok: serviceTargetDefined(s),     detail: serviceMode(s) === "local" ? (s.localKind ?? "local") : (platform(s.platform).name || "—") },
    { id: "envs",     label: "Environment ladder defined", ok: s.envs.length >= 2,           detail: `${s.envs.length} environments` },
    { id: "pipeline", label: "CI/CD pipeline staged",      ok: s.pipeline.stages.length >= 2, detail: s.pipeline.provider },
    { id: "secrets",  label: "Secrets wired for every env", ok: prodSecrets,                 detail: prodSecrets ? "all set" : "missing prod" },
    { id: "release",  label: "Release & rollback strategy", ok: !!s.release.strategy,        detail: s.release.strategy || "—" },
  ];
}

/** Whether a single repo's deploy plan is complete (all its checks pass). */
export function serviceReady(s: DeployService): boolean {
  return serviceChecks(s).every((c) => c.ok);
}

/** How many of the project's repos are fully deploy-ready (drives "N of M repos deploy-ready"). */
export function readyServiceCount(d: DeployConfig | undefined): number {
  return d ? d.services.filter(serviceReady).length : 0;
}

/** The `deploymentDefined` gate signal: at least one repo, and EVERY repo's deploy plan complete. */
export function deploymentDefined(d: DeployConfig | undefined): boolean {
  return !!d && d.services.length > 0 && d.services.every(serviceReady);
}

/** A deployment task this config will generate as a `stream:deploy` issue at publish. */
export interface DeployIssue { text: string; tag: string; blocking: boolean }

/** Preview the `stream:deploy` issues ONE service generates at publish — its deploy/publish/package
 *  workflow, non-prod env provisioning, prod secret wiring (blocking while unset), and (for anything
 *  that RUNS) a prod health check. */
export function serviceIssues(s: DeployService): DeployIssue[] {
  const out: DeployIssue[] = [];
  if (!serviceTargetDefined(s)) return out;
  if (serviceMode(s) === "local") {
    out.push(s.localKind === "library"
      ? { text: `Add ${s.publishRegistry ?? "registry"} publish workflow for ${s.id} (${s.packageName || s.id})`, tag: "all", blocking: false }
      : { text: `Add package + build workflow for ${s.id} → ${s.buildTargets || "local artifact"}`, tag: "all", blocking: false });
  } else {
    out.push({ text: `Add ${platform(s.platform).name} deploy workflow for ${s.id} → ${WORKLOAD[s.workload].label}`, tag: "all", blocking: false });
  }
  for (const e of s.envs.filter((e) => e.id !== "prod" && e.name !== "prod" && e.id !== "dev" && e.name !== "dev")) {
    out.push({ text: `Provision ${s.id} ${e.name} environment + secrets`, tag: e.name, blocking: false });
  }
  const unwired = s.config.secrets.filter((row) => !row.prod);
  if (unwired.length) {
    out.push({ text: `Wire ${s.id} prod secrets (${unwired.map((r) => r.key).join(", ")})`, tag: "prod", blocking: true });
  }
  if (!(serviceMode(s) === "local" && s.localKind === "library")) {
    out.push({ text: `Add ${s.id} prod health check + auto-rollback`, tag: "prod", blocking: false });
  }
  return out;
}

/** Preview every `stream:deploy` issue this project's deploy plan generates — across all repos. */
export function deployIssues(d: DeployConfig): DeployIssue[] {
  return d.services.flatMap(serviceIssues);
}
