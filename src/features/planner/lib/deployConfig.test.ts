import { describe, it, expect } from "vitest";
import {
  defaultDeployConfig, normalizeDeployConfig, serviceChecks, serviceReady, deploymentDefined, readyServiceCount,
  coerceDeployConfig, parseDeployConfigTag, deployIssues,
  serviceMode, serviceTargetDefined, localTargetDefined, finalStageName,
  type DeployService, type DeployConfig,
} from "./deployConfig";
import { makeBlueprints } from "../stages/blueprints";

// Per-repo rework (#1421): every repo carries its OWN envs/pipeline/config/release/health, so the
// checks + issues are per-service and the gate is `services.every(serviceReady)`.

describe("deployIssues (per-repo, #1421)", () => {
  it("previews one deploy workflow per targeted service + env provisioning + a prod health check", () => {
    const d = defaultDeployConfig(["acme/web"]);
    d.services[0].platform = "vercel";
    d.services[0].workload = "static";
    const issues = deployIssues(d);
    expect(issues.some((i) => i.text.includes("Vercel deploy workflow for web → static"))).toBe(true);
    expect(issues.some((i) => i.text.includes("staging environment"))).toBe(true);
    expect(issues.some((i) => i.text.includes("prod health check + auto-rollback"))).toBe(true);
  });

  it("flags unwired prod secrets as a blocking issue", () => {
    const d = defaultDeployConfig(["acme/web"]);
    d.services[0].platform = "vercel";
    d.services[0].config.secrets = [{ key: "DATABASE_URL", dev: true, staging: true, prod: false }];
    const issues = deployIssues(d);
    const sec = issues.find((i) => i.text.includes("prod secrets"));
    expect(sec).toBeDefined();
    expect(sec!.blocking).toBe(true);
    expect(sec!.text).toContain("DATABASE_URL");
  });

  it("generates nothing service-related until a target is picked", () => {
    expect(deployIssues(defaultDeployConfig(["acme/web"])).some((i) => i.text.includes("deploy workflow"))).toBe(false);
  });
});

describe("deployConfig (per-repo, #1421)", () => {
  it("seeds one proposed service per repo, each with its own env/pipeline ladder", () => {
    const d = defaultDeployConfig(["acme/web", "acme/api"]);
    expect(d.services.map((s) => s.id)).toEqual(["web", "api"]);
    expect(d.services.every((s) => s.proposed && s.platform === "")).toBe(true);
    expect(d.services.every((s) => s.envs.length === 3)).toBe(true);            // dev / staging / prod
    expect(d.services.every((s) => s.pipeline.stages.length === 3)).toBe(true); // build / test / deploy
    expect(d.services.every((s) => s.release.strategy === "")).toBe(true);
  });

  it("a fresh service is not ready (no target, no release strategy) but its env/pipeline/secrets pass", () => {
    const s = defaultDeployConfig(["acme/web"]).services[0];
    const checks = serviceChecks(s);
    expect(checks.find((c) => c.id === "target")!.ok).toBe(false);
    expect(checks.find((c) => c.id === "release")!.ok).toBe(false);
    expect(checks.find((c) => c.id === "envs")!.ok).toBe(true);
    expect(checks.find((c) => c.id === "pipeline")!.ok).toBe(true);
    expect(checks.find((c) => c.id === "secrets")!.ok).toBe(true);
    expect(serviceReady(s)).toBe(false);
    expect(deploymentDefined(defaultDeployConfig(["acme/web"]))).toBe(false);
  });

  it("deploymentDefined becomes true once EVERY repo has a target + release strategy", () => {
    const base = defaultDeployConfig(["acme/web", "acme/api"]);
    const ship = (s: DeployService): DeployService => ({ ...s, platform: "vercel", release: { ...s.release, strategy: "rolling" } });
    // one repo ready, the other not → still blocked
    const partial = { services: [ship(base.services[0]), base.services[1]] };
    expect(deploymentDefined(partial)).toBe(false);
    expect(readyServiceCount(partial)).toBe(1);
    // both ready → gate clears
    const all = { services: base.services.map(ship) };
    expect(deploymentDefined(all)).toBe(true);
    expect(readyServiceCount(all)).toBe(2);
  });

  it("migrates a legacy top-level config (pre-#1421) so each service stays deploy-ready (#1438)", () => {
    // The pre-rework shape: environments/pipeline/release/secrets at the TOP LEVEL, services without
    // their own. Before the fix each service reset to release.strategy "" and the gate stuck.
    const legacy = {
      environments: [{ name: "dev", branch: "feature/*", auto: true }, { name: "staging", branch: "develop", auto: true }, { name: "prod", branch: "main", auto: false }],
      pipeline: { provider: "GitHub Actions", stages: [{ name: "build", trigger: "push" }, { name: "test", trigger: "on-green", gate: true }, { name: "deploy", trigger: "on-green" }] },
      release: { strategy: "rolling", autoRollback: true, keep: 3, migrateWithDeploy: true },
      secrets: [{ key: "DATABASE_URL", envs: ["dev", "staging", "prod"] }],
      services: [
        { id: "widget", repo: "acme/services", platform: "railway", workload: "container", build: "pnpm build" },
        { id: "ui", repo: "acme/ui", platform: "vercel", workload: "static", build: "pnpm build", output: "dist" },
      ],
    };
    const cfg = coerceDeployConfig(legacy, ["acme/services", "acme/ui"]);
    expect(cfg.services.every((s) => s.release.strategy === "rolling")).toBe(true); // top-level release folded in
    expect(cfg.services.every((s) => s.envs.length === 3)).toBe(true);              // top-level envs folded in
    expect(cfg.services.every((s) => s.pipeline.stages.length === 3)).toBe(true);   // top-level pipeline folded in
    expect(deploymentDefined(cfg)).toBe(true);                                      // the gate now clears
    expect(deploymentDefined(normalizeDeployConfig(cfg, []))).toBe(true);           // and survives normalize
  });

  it("blocks while a repo's prod secret is unwired", () => {
    const base = defaultDeployConfig(["acme/web"]);
    const d = {
      services: base.services.map((s) => ({
        ...s, platform: "vercel", release: { ...s.release, strategy: "rolling" as const },
        config: { ...s.config, secrets: [{ key: "DATABASE_URL", dev: true, staging: true, prod: false }] },
      })),
    };
    expect(deploymentDefined(d)).toBe(false);
    expect(serviceChecks(d.services[0]).find((c) => c.id === "secrets")!.ok).toBe(false);
  });

  it("undefined config is not gate-ready", () => {
    expect(deploymentDefined(undefined)).toBe(false);
  });
});

describe("coerceDeployConfig — the planner deploy channel (per-repo, #1421)", () => {
  it("clears the gate from a planner-style payload (per-service envs/pipeline/secrets/release)", () => {
    const d = coerceDeployConfig({
      services: [{
        id: "web", repo: "o/web", platform: "vercel", workload: "static",
        environments: [{ name: "dev", branch: "feature/*" }, { name: "staging", branch: "develop" }, { name: "prod", branch: "main" }],
        pipeline: { provider: "GitHub Actions", stages: [{ name: "build" }, { name: "test", gate: true }, { name: "deploy" }] },
        secrets: [{ key: "DATABASE_URL", envs: ["dev", "staging", "prod"] }],
        release: { strategy: "blue-green", autoRollback: true },
      }],
    });
    expect(deploymentDefined(d)).toBe(true);
    expect(d.services[0].platform).toBe("vercel");
    expect(d.services[0].envs.length).toBe(3);
    expect(d.services[0].release.strategy).toBe("blue-green");
  });

  it("blocks when a service has no platform", () => {
    const d = coerceDeployConfig({ services: [{ id: "web", release: { strategy: "rolling" } }] });
    expect(deploymentDefined(d)).toBe(false);
    expect(serviceChecks(d.services[0]).find((c) => c.id === "target")!.ok).toBe(false);
  });

  it("blocks when a secret omits prod from its envs", () => {
    const d = coerceDeployConfig({
      services: [{ id: "web", repo: "o/web", platform: "vercel", release: { strategy: "rolling" }, secrets: [{ key: "X", envs: ["dev", "staging"] }] }],
    });
    expect(serviceChecks(d.services[0]).find((c) => c.id === "secrets")!.ok).toBe(false);
    expect(deploymentDefined(d)).toBe(false);
  });

  it("coerces an invalid release strategy to empty (blocks) and bad input to a safe default", () => {
    const bad = coerceDeployConfig({ services: [{ id: "web", platform: "fly", release: { strategy: "yolo" } }] });
    expect(bad.services[0].release.strategy).toBe("");
    expect(coerceDeployConfig(null).services.length).toBeGreaterThan(0); // never throws on garbage
  });

  it("parseDeployConfigTag survives stray content around the JSON (e.g. a leaked </parameter>)", () => {
    const body = `
{
  "services": [{
    "id":"user","repo":"o/user","platform":"fly","workload":"container",
    "environments": [{"name":"staging","branch":"develop"},{"name":"prod","branch":"main"}],
    "pipeline": {"provider":"GitHub Actions","stages":[{"name":"test","gate":true},{"name":"deploy"}]},
    "secrets": [{"key":"DATABASE_URL","envs":["staging","prod"]}],
    "release": {"strategy":"rolling","autoRollback":true}
  }]
}
</parameter>`;
    const cfg = parseDeployConfigTag(body);
    expect(cfg).not.toBeNull();
    expect(deploymentDefined(cfg!)).toBe(true);
  });

  it("parseDeployConfigTag returns null when there's no JSON object", () => {
    expect(parseDeployConfigTag("no json here")).toBeNull();
  });

  it("repairs terminal-wrapped JSON with a raw newline INSIDE a string value", () => {
    // The planner CLI wrapped the big JSON at terminal width, injecting a raw newline + indent
    // mid-string (`"fly\n  app …"`) — which makes JSON.parse throw. The parser must repair + parse.
    const wrapped =
      '<deploy_config>\n  {\n' +
      '    "services": [{"id": "user", "repo": "o/user", "platform": "fly", "workload":\n' +
      '  "container", "region": "iad", "build": "docker build", "output": "fly\n' +
      '  app chirp-user-{env}",\n' +
      '    "environments": [{"name":"staging","branch":"develop"},{"name":"prod","branch":"main"}],\n' +
      '    "pipeline": {"provider":"GitHub Actions","stages":[{"name":"test","gate":true},{"name":"deploy"}]},\n' +
      '    "secrets": [{"key":"DATABASE_URL","envs":["staging","prod"]}],\n' +
      '    "release": {"strategy":"rolling","autoRollback":true}}]\n' +
      '  }\n</deploy_config>';
    const body = wrapped.replace(/^<deploy_config>/, "").replace(/<\/deploy_config>$/, "");
    const cfg = parseDeployConfigTag(body);
    expect(cfg).not.toBeNull();
    expect(cfg!.services[0].platform).toBe("fly");
    expect(deploymentDefined(cfg!)).toBe(true);
  });
});

describe("normalizeDeployConfig — migrating a pre-rework persisted config (#1425)", () => {
  // A config persisted BEFORE the per-repo rework: envs/pipeline/config/release/health lived at the
  // TOP level and the services had none of them. The per-service readers would crash on `s.config`.
  const legacy = {
    selService: "web",
    services: [{ id: "web", repo: "acme/web", path: ".", stack: "TS", platform: "vercel", workload: "static", proposed: false, region: "—", build: "—", output: "dist", runtime: "—" }],
    envs: [{ id: "dev", name: "dev", branch: "develop", url: "", auto: true }, { id: "prod", name: "prod", branch: "main", url: "", auto: false }],
    pipeline: { provider: "GitHub Actions", stages: [{ id: "build", name: "build", trigger: "push", gate: false, cmd: "" }, { id: "deploy", name: "deploy", trigger: "on-green", gate: false, cmd: "" }] },
    config: { config: [], secrets: [{ key: "DATABASE_URL", dev: true, prod: true }], vault: "host vault" },
    release: { strategy: "rolling", autoRollback: true, keep: 3, migrateWithDeploy: false },
    health: { probe: "/healthz", probeOn: false, slo: "", sloOn: false, alerts: "", alertsOn: false },
  } as unknown as DeployConfig;

  it("backfills each service from the legacy top-level so the per-service readers don't throw", () => {
    const d = normalizeDeployConfig(legacy);
    const s = d.services[0];
    expect(s.config.secrets).toEqual([{ key: "DATABASE_URL", dev: true, prod: true }]); // pulled from top-level
    expect(s.envs.map((e) => e.name)).toEqual(["dev", "prod"]);
    expect(s.pipeline.stages.length).toBe(2);
    expect(s.release.strategy).toBe("rolling");
    // the readers that used to crash now run, and the gate evaluates
    expect(() => serviceChecks(s)).not.toThrow();
    expect(deploymentDefined(d)).toBe(true);
  });

  it("backfills services that have NO sub-configs at all (defaults) without crashing", () => {
    const bare = { services: [{ id: "web", repo: "acme/web", platform: "", workload: "static", proposed: true, path: ".", stack: "—", region: "—", build: "—", output: "dist", runtime: "—" }] } as unknown as DeployConfig;
    const d = normalizeDeployConfig(bare);
    expect(d.services[0].envs.length).toBe(3);            // seeded ladder
    expect(d.services[0].config.secrets).toEqual([]);
    expect(() => deploymentDefined(d)).not.toThrow();
  });

  it("falls back to a fresh default config for an undefined/empty config", () => {
    expect(normalizeDeployConfig(undefined, ["acme/web"]).services[0].id).toBe("web");
    expect(normalizeDeployConfig({ services: [] }, ["acme/api"]).services[0].id).toBe("api");
  });

  it("leaves an already-per-repo config untouched", () => {
    const fresh = defaultDeployConfig(["acme/web"]);
    expect(normalizeDeployConfig(fresh)).toEqual(fresh);
  });
});

describe("local vs cloud deploy modes (#1192)", () => {
  it("seeds services in cloud mode by default", () => {
    const d = defaultDeployConfig(["acme/web"]);
    expect(d.services[0].mode).toBe("cloud");
    expect(serviceMode(d.services[0])).toBe("cloud");
  });

  it("treats a service with no `mode` (legacy config) as cloud", () => {
    const d = defaultDeployConfig(["acme/web"]);
    const legacy = { ...d.services[0] };
    delete (legacy as { mode?: string }).mode;
    expect(serviceMode(legacy)).toBe("cloud");
    legacy.platform = "vercel";
    expect(serviceTargetDefined(legacy)).toBe(true);
  });

  it("a local LIBRARY satisfies `target` via publish registry + package name, not a cloud platform", () => {
    const base = defaultDeployConfig(["acme/sdk"]);
    const lib = { ...base.services[0], mode: "local" as const, localKind: "library" as const, platform: "" };
    expect(localTargetDefined(lib)).toBe(false);
    expect(serviceTargetDefined(lib)).toBe(false);
    const ready = { ...lib, publishRegistry: "npm" as const, packageName: "@acme/sdk" };
    expect(localTargetDefined(ready)).toBe(true);
    expect(serviceTargetDefined(ready)).toBe(true);
    const shipped = { ...ready, release: { ...ready.release, strategy: "rolling" as const } };
    expect(serviceChecks(shipped).find((c) => c.id === "target")!.ok).toBe(true);
    expect(deploymentDefined({ services: [shipped] })).toBe(true);
  });

  it("a local APPLICATION satisfies `target` via build targets + artifact", () => {
    const base = defaultDeployConfig(["acme/cli"]);
    const app = { ...base.services[0], mode: "local" as const, localKind: "application" as const, platform: "" };
    expect(serviceTargetDefined(app)).toBe(false);
    const ready = { ...app, buildTargets: "linux/amd64, darwin/arm64", artifact: "acme-cli" };
    expect(serviceTargetDefined(ready)).toBe(true);
  });

  it("finalStageName adapts to the service mode: deploy · publish · package", () => {
    const base = defaultDeployConfig(["acme/web"]).services[0];
    expect(finalStageName(base)).toBe("deploy");
    expect(finalStageName({ ...base, mode: "local", localKind: "library" })).toBe("publish");
    expect(finalStageName({ ...base, mode: "local", localKind: "application" })).toBe("package");
    expect(finalStageName(undefined)).toBe("deploy");
  });

  it("coerceDeployConfig accepts a local library service + port forwarding", () => {
    const d = coerceDeployConfig({
      services: [
        { id: "sdk", repo: "o/sdk", mode: "local", localKind: "library", publishRegistry: "npm", packageName: "@o/sdk", publishTrigger: "on-tag", release: { strategy: "rolling" } },
        { id: "cli", repo: "o/cli", mode: "local", localKind: "application", buildTargets: "linux/amd64", artifact: "cli", runCmd: "./cli",
          portForward: { enabled: true, port: "8080", method: "cloudflared" }, release: { strategy: "rolling" } },
      ],
    });
    expect(d.services[0].mode).toBe("local");
    expect(d.services[0].localKind).toBe("library");
    expect(d.services[0].publishRegistry).toBe("npm");
    expect(d.services[0].packageName).toBe("@o/sdk");
    expect(d.services[1].localKind).toBe("application");
    expect(d.services[1].portForward).toEqual({ enabled: true, port: "8080", method: "cloudflared" });
    expect(deploymentDefined(d)).toBe(true);
  });

  it("coerce falls back to cloudflared for an unknown port-forward method", () => {
    const d = coerceDeployConfig({
      services: [{ id: "cli", repo: "o/cli", mode: "local", localKind: "application", buildTargets: "x", artifact: "y",
        portForward: { enabled: true, port: "9000", method: "bogus" }, release: { strategy: "rolling" } }],
    });
    expect(d.services[0].portForward!.method).toBe("cloudflared");
  });

  it("deployIssues emits a publish workflow for a library and a package workflow for a local app", () => {
    const base = defaultDeployConfig(["o/sdk"]);
    const lib = deployIssues({ services: [{ ...base.services[0], mode: "local", localKind: "library", publishRegistry: "crates.io", packageName: "acme" }] });
    expect(lib.some((i) => i.text.includes("crates.io publish workflow"))).toBe(true);
    expect(lib.some((i) => i.text.includes("deploy workflow"))).toBe(false);
    expect(lib.some((i) => i.text.includes("prod health check"))).toBe(false); // a library has nothing running

    const app = deployIssues({ services: [{ ...base.services[0], mode: "local", localKind: "application", buildTargets: "linux/amd64", artifact: "cli" }] });
    expect(app.some((i) => i.text.includes("package + build workflow"))).toBe(true);
    expect(app.some((i) => i.text.includes("prod health check"))).toBe(true);
  });
});

describe("Deploy stage placement (#919, collapsed into `deployment` #1914)", () => {
  it("the Default blueprint's `deployment` stage carries link+ship substeps (no separate `deploy`/`repos` section)", () => {
    const def = makeBlueprints().find((b) => b.id === "default")!;
    const keys = def.sections.map((s) => s.key);
    expect(keys).not.toContain("deploy"); // collapsed into deployment
    expect(keys).not.toContain("repos");  // collapsed into deployment
    const deployment = def.sections.find((s) => s.key === "deployment")!;
    expect(deployment.substeps?.map((s) => s.key)).toEqual(["link", "ship"]);
  });
});
