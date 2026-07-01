// Planner deploy channel (#919/#1421) — coerce the planner's lenient/partial deploy config JSON into
// a full DeployConfig, and parse the `<deploy_config>` tag body. Pure (no React/Tauri). Split out of
// deployConfig.ts (#1639).
//
// The planner emits a lenient/partial shape, one service per repo, each carrying its own
// environments/pipeline/config/secrets/release/health; we overlay it onto seeded defaults so the gate
// can clear from the planner's output. Defensive: any missing piece falls back to a sensible default;
// the caller try/catches bad JSON and the planner re-emits.

import { repoShortName } from "@/shared/lib/core/projectPaths";
import { platform, type Workload } from "./deployPlatforms";
import {
  PIPE_TRIGGERS, PUBLISH_REGISTRIES, PUBLISH_TRIGGERS, PORT_FORWARD_METHODS,
  type DeployEnvironment, type Pipeline, type DeployConfigBlock, type DeployConfigRow, type DeploySecretRow,
  type ReleasePolicy, type HealthPolicy, type PipeTrigger,
  type DeployMode, type LocalKind, type PublishRegistry, type PublishTrigger, type PortForward, type PortForwardMethod,
} from "./deployEnv";
import { defaultDeployConfig, defaultService, type DeployService, type DeployConfig } from "./deployServices";

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
  return {
    // Preserve ANY non-empty strategy the planner authored — not just the four cloud-rollout enum
    // values (#2021). A release-artifact deploy (GitHub Pages/Releases, npm publish, packaging) has a
    // legitimate free-text strategy; the old enum-only check dropped it to "" and silently jammed the
    // deploy gate (the poll's coercion disagreed with `normalizeDeployConfig`, which the gate trusts).
    strategy: asStr(rawRel.strategy),
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
