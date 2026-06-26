// Deployment & infrastructure config (#919; per-repo rework #1421) — the data model behind the
// planner's Deployment stage (right after Repos). Pure (no React/Tauri) so the readiness checks that
// drive the stage gate are unit-testable. Ported from design/bsc project planner focused/planner;
// reshaped to the per-repo design (design/Claude design_ deployment section/Deployment.dc.html).
//
// One DeployConfig per project (store slice `planDeployConfig`) holding ONE DeployService per linked
// repo. Each service is a fully self-contained deployable unit — it owns its OWN environments,
// pipeline, config/secrets, release, and health. The `deploymentDefined` gate signal is
// `services.length > 0 && services.every(serviceReady)`; the pane shows "N of M repos deploy-ready".

import { repoShortName } from "@/shared/lib/core/projectPaths";
import type { ReadinessCheck } from "./readiness";

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

/** A git host a project's repos can live on — a project may span clouds or a self-hosted server. */
export interface GitHost { key: string; domain: string; label: string; kind: "cloud" | "self-hosted"; color: string }
export const HOSTS: Record<string, GitHost> = {
  github:     { key: "github",     domain: "github.com",  label: "GitHub",      kind: "cloud",       color: "var(--info)" },
  gitlab:     { key: "gitlab",     domain: "gitlab.com",  label: "GitLab",      kind: "cloud",       color: "var(--accent)" },
  bitbucket:  { key: "bitbucket",  domain: "bitbucket.org", label: "Bitbucket", kind: "cloud",       color: "var(--info)" },
  selfhosted: { key: "selfhosted", domain: "self-hosted", label: "self-hosted", kind: "self-hosted", color: "var(--violet)" },
};
export function hostMeta(id: string | undefined): GitHost {
  return HOSTS[id ?? "github"] ?? HOSTS.github;
}

/** Orchestrators a distributed (container) workload can run under. */
export const ORCHESTRATORS: { id: string; label: string }[] = [
  { id: "k8s", label: "Kubernetes" }, { id: "swarm", label: "Docker Swarm" }, { id: "nomad", label: "Nomad" },
];
/** Replica-count options for a container workload (string so "auto" fits the same control). */
export const REPLICA_OPTIONS = ["1", "3", "5", "auto"] as const;

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

/** A sensible default environment ladder a repo's deploy plan starts from. */
function defaultEnvs(): DeployEnvironment[] {
  return [
    { id: "dev",     name: "dev",     branch: "feature/*", url: "", auto: true,  proposed: true },
    { id: "staging", name: "staging", branch: "develop",   url: "", auto: true,  proposed: true },
    { id: "prod",    name: "prod",    branch: "main",       url: "", auto: false, proposed: true },
  ];
}
/** A sensible default pipeline a repo's deploy plan starts from. */
function defaultPipeline(): Pipeline {
  return {
    provider: "GitHub Actions",
    stages: [
      { id: "build",  name: "build",  trigger: "push",     gate: false, cmd: "" },
      { id: "test",   name: "test",   trigger: "on-green", gate: true,  cmd: "" },
      { id: "deploy", name: "deploy", trigger: "on-green", gate: false, cmd: "" },
    ],
  };
}
function defaultRelease(): ReleasePolicy {
  return { strategy: "", autoRollback: true, keep: 3, migrateWithDeploy: false };
}
function defaultHealth(): HealthPolicy {
  return { probe: "/healthz", probeOn: false, slo: "", sloOn: false, alerts: "", alertsOn: false };
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

// ── Planner channel (#919/#1421): coerce the planner's deploy config JSON → a full DeployConfig ──
// The planner emits a lenient/partial shape, one service per repo, each carrying its own
// environments/pipeline/config/secrets/release/health; we overlay it onto seeded defaults so the gate
// can clear from the planner's output. Defensive: any missing piece falls back to a sensible default;
// the caller try/catches bad JSON and the planner re-emits.
type Raw = Record<string, unknown>;
const asArr = (v: unknown): Raw[] => Array.isArray(v) ? v.filter((x): x is Raw => !!x && typeof x === "object") : [];
const asStr = (v: unknown, d = ""): string => typeof v === "string" ? v : d;
const asBool = (v: unknown, d: boolean): boolean => typeof v === "boolean" ? v : d;

/** Coerce a service's environment ladder (accepts `environments` or `envs`). */
function coerceEnvs(o: Raw, base: DeployEnvironment[]): DeployEnvironment[] {
  const raw = asArr(o.environments).length ? asArr(o.environments) : asArr(o.envs);
  const envs = (raw.length ? raw : base).map((e, i) => {
    const name = asStr(e.name) || base[i]?.name || `env-${i + 1}`;
    return { id: asStr(e.id) || name, name, branch: asStr(e.branch, "main"), url: asStr(e.url), auto: asBool(e.auto, true) };
  });
  return envs.length ? envs : base;
}

/** Coerce a service's pipeline. */
function coercePipeline(o: Raw, base: Pipeline): Pipeline {
  const rawPipe = (o.pipeline && typeof o.pipeline === "object" ? o.pipeline : {}) as Raw;
  const rawStages = asArr(rawPipe.stages);
  return {
    provider: asStr(rawPipe.provider, base.provider),
    stages: (rawStages.length ? rawStages : base.stages).map((st, i) => {
      const trig = asStr(st.trigger) as PipeTrigger;
      return {
        id: asStr(st.id) || asStr(st.name) || `stage-${i + 1}`,
        name: asStr(st.name) || `stage-${i + 1}`,
        trigger: PIPE_TRIGGERS.includes(trig) ? trig : "push",
        gate: asBool(st.gate, false), cmd: asStr(st.cmd),
      };
    }),
  };
}

/** Coerce a service's config block. A secret may carry `envs: ["dev","prod"]` OR per-env booleans;
 *  an unspecified secret defaults to wired in every env (so the planner needn't enumerate). */
function coerceConfigBlock(o: Raw, envs: DeployEnvironment[]): DeployConfigBlock {
  const config: DeployConfigRow[] = asArr(o.config).map((r) => {
    const row: DeployConfigRow = { key: asStr(r.key) };
    for (const e of envs) row[e.id] = asStr(r[e.id]);
    return row;
  });
  const secrets: DeploySecretRow[] = asArr(o.secrets).map((r) => {
    const listed = Array.isArray(r.envs) ? new Set((r.envs as unknown[]).map((x) => String(x))) : null;
    const row: DeploySecretRow = { key: asStr(r.key) };
    for (const e of envs) {
      row[e.id] = listed ? (listed.has(e.id) || listed.has(e.name)) : (typeof r[e.id] === "boolean" ? (r[e.id] as boolean) : true);
    }
    return row;
  });
  return { config, secrets, vault: asStr((o.config as Raw)?.vault) || asStr(o.vault, "host vault") };
}

function coerceRelease(o: Raw, base: ReleasePolicy): ReleasePolicy {
  const rawRel = (o.release && typeof o.release === "object" ? o.release : {}) as Raw;
  const strat = asStr(rawRel.strategy) as ReleaseStrategy;
  return {
    strategy: RELEASE_STRATEGIES.some((s) => s.id === strat) ? strat : "",
    autoRollback: asBool(rawRel.autoRollback, base.autoRollback),
    keep: typeof rawRel.keep === "number" ? rawRel.keep : base.keep,
    migrateWithDeploy: asBool(rawRel.migrateWithDeploy, base.migrateWithDeploy),
  };
}

function coerceHealth(o: Raw, base: HealthPolicy): HealthPolicy {
  const rawHealth = (o.health && typeof o.health === "object" ? o.health : {}) as Raw;
  return {
    probe: asStr(rawHealth.probe, base.probe), probeOn: asBool(rawHealth.probeOn, !!asStr(rawHealth.probe)),
    slo: asStr(rawHealth.slo), sloOn: asBool(rawHealth.sloOn, !!asStr(rawHealth.slo)),
    alerts: asStr(rawHealth.alerts), alertsOn: asBool(rawHealth.alertsOn, !!asStr(rawHealth.alerts)),
  };
}

/** Coerce one planner-emitted service object onto the seeded default for its repo. */
function coerceService(s: Raw, base: DeployService, idx: number): DeployService {
  const repo = asStr(s.repo, base.repo);
  const id = asStr(s.id) || (repo ? repoShortName(repo) : `service-${idx + 1}`);
  const plat = platform(asStr(s.platform));
  const wl = asStr(s.workload) as Workload;
  const workload: Workload = plat.kinds.includes(wl) ? wl : (plat.kinds[0] ?? "static");
  const reps = typeof s.replicas === "number" ? String(s.replicas) : asStr(s.replicas);
  const mode: DeployMode = asStr(s.mode) === "local" ? "local" : "cloud";
  const rawKind = asStr(s.localKind);
  const localKind: LocalKind | undefined = rawKind === "library" || rawKind === "application" ? rawKind : (mode === "local" ? "application" : undefined);
  const rawReg = asStr(s.publishRegistry);
  const publishRegistry = (PUBLISH_REGISTRIES as readonly string[]).includes(rawReg) ? (rawReg as PublishRegistry) : undefined;
  const rawTrig = asStr(s.publishTrigger);
  const publishTrigger = (PUBLISH_TRIGGERS as readonly string[]).includes(rawTrig) ? (rawTrig as PublishTrigger) : undefined;
  const pf = (s.portForward && typeof s.portForward === "object" ? s.portForward : null) as Raw | null;
  const rawMethod = pf ? asStr(pf.method) : "";
  const portForward: PortForward | undefined = pf
    ? { enabled: asBool(pf.enabled, false), port: asStr(pf.port), method: (PORT_FORWARD_METHODS as readonly string[]).includes(rawMethod) ? (rawMethod as PortForwardMethod) : "cloudflared" }
    : undefined;
  const envs = coerceEnvs(s, base.envs);
  return {
    id, repo, path: asStr(s.path, "."), stack: asStr(s.stack, "—"),
    platform: asStr(s.platform), workload, proposed: false,
    region: asStr(s.region, "—"), build: asStr(s.build, "—"),
    output: asStr(s.output, "dist"), runtime: asStr(s.runtime, "—"),
    host: asStr(s.host) || base.host || "github",
    registry: asStr(s.registry) || undefined,
    orchestrator: asStr(s.orchestrator) || undefined,
    replicas: reps || undefined,
    mode,
    localKind: mode === "local" ? localKind : (localKind || undefined),
    publishRegistry,
    packageName: asStr(s.packageName) || undefined,
    publishTrigger,
    buildTargets: asStr(s.buildTargets) || undefined,
    artifact: asStr(s.artifact) || undefined,
    runCmd: asStr(s.runCmd) || undefined,
    portForward,
    envs,
    pipeline: coercePipeline(s, base.pipeline),
    config: coerceConfigBlock(s, envs),
    release: coerceRelease(s, base.release),
    health: coerceHealth(s, base.health),
  };
}

export function coerceDeployConfig(raw: unknown, repos: string[] = []): DeployConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Raw;
  const base = defaultDeployConfig(repos);
  const rawServices = asArr(o.services);
  // A config saved before the per-repo rework (#1421) carries environments/pipeline/config/secrets/
  // release/health at the TOP LEVEL, shared across services; the per-repo model wants them ON each
  // service. Fold the top-level set into a service that lacks its own, so a migrated legacy config
  // stays deploy-ready (its `release.strategy` etc. reach each service) instead of resetting to empty
  // defaults and silently blocking the gate (#1438). A service's own fields always win.
  const legacyTop: Raw = {
    environments: o.environments ?? o.envs, pipeline: o.pipeline,
    config: o.config, secrets: o.secrets, release: o.release, health: o.health,
  };
  const services: DeployService[] = (rawServices.length ? rawServices : base.services as unknown as Raw[]).map((s, i) =>
    coerceService({ ...legacyTop, ...(s as Raw) }, base.services[i] ?? defaultService(asStr((s as Raw).repo)), i),
  );
  return { services };
}

/** Parse the body of a `<deploy_config>` tag into a DeployConfig. Forgiving on two fronts (#919):
 *  (1) stray prose/tags around the JSON (e.g. a leaked `</parameter>`) — we extract the outermost
 *  `{ … }` object; (2) the planner CLI's terminal line-WRAPS the big JSON block, injecting raw
 *  newlines + indent that can land INSIDE string values (invalid JSON). When a clean parse fails we
 *  collapse newline-spanning whitespace to a single space and retry, which repairs the wraps
 *  (`"fly  \n  app"` → `"fly app"`). Returns null only if neither parse works. */
export function parseDeployConfigTag(body: string, repos: string[] = []): DeployConfig | null {
  const json = body.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };
  // Raw newlines are only ever wrap artifacts inside a JSON string (real string newlines are escaped
  // `\n`), so collapsing them is safe; between tokens it's just whitespace JSON ignores anyway.
  const parsed = tryParse(json) ?? tryParse(json.replace(/[ \t]*[\r\n]+[ \t]*/g, " "));
  if (parsed === undefined || parsed === null) return null;
  try {
    return coerceDeployConfig(parsed, repos);
  } catch {
    return null;
  }
}
