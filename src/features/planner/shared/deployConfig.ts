// Deployment & infrastructure config (#919) — the data model behind the planner's Deploy stage
// (right after Repos). Pure (no React/Tauri) so the readiness checks that drive the stage gate
// are unit-testable. Ported from design/bsc project planner focused/planner.
//
// One DeployConfig per project (store slice `planDeployConfig`). The Deploy pane edits it; the
// `deploymentDefined` gate signal (planStageDerive) is `deployChecks(config).every(ok)`.

import { repoShortName } from "@/shared/lib/core/projectPaths";

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
  /** Git host the repo lives on (key into {@link HOSTS}) — display only; defaults to github. */
  host?: string;
  /** Container image registry for a container workload. Absent ⇒ derived `ghcr.io/<repo>`. */
  registry?: string;
  /** Orchestrator id for a distributed container workload (see {@link ORCHESTRATORS}). */
  orchestrator?: string;
  /** Replica count for a container workload — a {@link REPLICA_OPTIONS} value ("auto" allowed). */
  replicas?: string;
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
      region: "—", build: "—", output: "dist", runtime: "—", host: "github",
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

/** A deployment task this config will generate as a `stream:deploy` issue at publish. */
export interface DeployIssue { text: string; tag: string; blocking: boolean }

/** Preview the `stream:deploy` issues this config generates at publish — one deploy workflow per
 *  targeted service, environment provisioning, secret wiring (blocking while prod secrets are
 *  unset), and a prod health check. Pure; surfaced read-only in the Readiness group. */
export function deployIssues(d: DeployConfig): DeployIssue[] {
  const out: DeployIssue[] = [];
  for (const s of d.services) {
    if (!s.platform) continue;
    out.push({ text: `Add ${platform(s.platform).name} deploy workflow for ${s.id} → ${WORKLOAD[s.workload].label}`, tag: "all", blocking: false });
  }
  for (const e of d.envs.filter((e) => e.id !== "prod" && e.name !== "prod" && e.id !== "dev" && e.name !== "dev")) {
    out.push({ text: `Provision ${e.name} environment + secrets`, tag: e.name, blocking: false });
  }
  const unwired = d.config.secrets.filter((row) => !row.prod);
  if (unwired.length) {
    out.push({ text: `Wire prod secrets (${unwired.map((r) => r.key).join(", ")})`, tag: "prod", blocking: true });
  }
  if (d.services.some((s) => s.platform)) {
    out.push({ text: "Add prod health check + auto-rollback", tag: "prod", blocking: false });
  }
  return out;
}

// ── Planner channel (#919): coerce the planner's `<deploy_config>` JSON → a full DeployConfig ──
// The planner emits a lenient/partial shape; we overlay it onto the seeded defaults so the gate
// can clear from the planner's output (not only manual pane edits). Defensive: any missing piece
// falls back to a sensible default; the caller try/catches bad JSON and the planner re-emits.
type Raw = Record<string, unknown>;
const asArr = (v: unknown): Raw[] => Array.isArray(v) ? v.filter((x): x is Raw => !!x && typeof x === "object") : [];
const asStr = (v: unknown, d = ""): string => typeof v === "string" ? v : d;
const asBool = (v: unknown, d: boolean): boolean => typeof v === "boolean" ? v : d;

export function coerceDeployConfig(raw: unknown, repos: string[] = []): DeployConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Raw;
  const base = defaultDeployConfig(repos);

  // services — keep the platform the planner picked (the gate's "target per service" check); id
  // defaults to the repo short-name; workload coerced against the platform's supported kinds.
  const rawServices = asArr(o.services);
  const services: DeployService[] = (rawServices.length ? rawServices : base.services).map((s, i) => {
    const repo = asStr(s.repo, base.services[i]?.repo ?? "");
    const id = asStr(s.id) || (repo ? repoShortName(repo) : `service-${i + 1}`);
    const plat = platform(asStr(s.platform));
    const wl = asStr(s.workload) as Workload;
    const workload: Workload = plat.kinds.includes(wl) ? wl : (plat.kinds[0] ?? "static");
    const reps = typeof s.replicas === "number" ? String(s.replicas) : asStr(s.replicas);
    return {
      id, repo, path: asStr(s.path, "."), stack: asStr(s.stack, "—"),
      platform: asStr(s.platform), workload, proposed: false,
      region: asStr(s.region, "—"), build: asStr(s.build, "—"),
      output: asStr(s.output, "dist"), runtime: asStr(s.runtime, "—"),
      host: asStr(s.host) || (base.services[i]?.host ?? "github"),
      registry: asStr(s.registry) || undefined,
      orchestrator: asStr(s.orchestrator) || undefined,
      replicas: reps || undefined,
    };
  });

  // environments (accepts `environments` or `envs`)
  const rawEnvs = asArr(o.environments).length ? asArr(o.environments) : asArr(o.envs);
  const envs: DeployEnvironment[] = (rawEnvs.length ? rawEnvs : base.envs).map((e, i) => {
    const name = asStr(e.name) || base.envs[i]?.name || `env-${i + 1}`;
    return { id: asStr(e.id) || name, name, branch: asStr(e.branch, "main"), url: asStr(e.url), auto: asBool(e.auto, true) };
  });

  // pipeline
  const rawPipe = (o.pipeline && typeof o.pipeline === "object" ? o.pipeline : {}) as Raw;
  const rawStages = asArr(rawPipe.stages);
  const pipeline: Pipeline = {
    provider: asStr(rawPipe.provider, base.pipeline.provider),
    stages: (rawStages.length ? rawStages : base.pipeline.stages).map((st, i) => {
      const trig = asStr(st.trigger) as PipeTrigger;
      return {
        id: asStr(st.id) || asStr(st.name) || `stage-${i + 1}`,
        name: asStr(st.name) || `stage-${i + 1}`,
        trigger: PIPE_TRIGGERS.includes(trig) ? trig : "push",
        gate: asBool(st.gate, false), cmd: asStr(st.cmd),
      };
    }),
  };

  // config + secrets. A secret may carry `envs: ["dev","prod"]` OR per-env booleans; an unspecified
  // secret defaults to wired in every env (so the planner needn't enumerate to clear the gate).
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

  // release + health
  const rawRel = (o.release && typeof o.release === "object" ? o.release : {}) as Raw;
  const strat = asStr(rawRel.strategy) as ReleaseStrategy;
  const release: ReleasePolicy = {
    strategy: RELEASE_STRATEGIES.some((s) => s.id === strat) ? strat : "",
    autoRollback: asBool(rawRel.autoRollback, base.release.autoRollback),
    keep: typeof rawRel.keep === "number" ? rawRel.keep : base.release.keep,
    migrateWithDeploy: asBool(rawRel.migrateWithDeploy, base.release.migrateWithDeploy),
  };
  const rawHealth = (o.health && typeof o.health === "object" ? o.health : {}) as Raw;
  const health: HealthPolicy = {
    probe: asStr(rawHealth.probe, base.health.probe), probeOn: asBool(rawHealth.probeOn, !!asStr(rawHealth.probe)),
    slo: asStr(rawHealth.slo), sloOn: asBool(rawHealth.sloOn, !!asStr(rawHealth.slo)),
    alerts: asStr(rawHealth.alerts), alertsOn: asBool(rawHealth.alertsOn, !!asStr(rawHealth.alerts)),
  };

  return {
    selService: services[0]?.id ?? "",
    services,
    envs: envs.length ? envs : base.envs,
    pipeline,
    config: { config, secrets, vault: asStr((o.config as Raw)?.vault) || asStr(o.vault, "host vault") },
    release, health,
  };
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
