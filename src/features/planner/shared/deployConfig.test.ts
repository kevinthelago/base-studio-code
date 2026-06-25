import { describe, it, expect } from "vitest";
import {
  defaultDeployConfig, deployChecks, deploymentDefined, coerceDeployConfig, parseDeployConfigTag, deployIssues,
  serviceMode, serviceTargetDefined, localTargetDefined, finalStageName,
} from "./deployConfig";
import { makeBlueprints } from "../stages/blueprints";

describe("deployIssues (#1167 — Deploy pane)", () => {
  it("previews one deploy workflow per targeted service + env provisioning + a prod health check", () => {
    const d = defaultDeployConfig(["acme/web"]);
    d.services[0].platform = "vercel";
    d.services[0].workload = "static";
    const issues = deployIssues(d);
    expect(issues.some((i) => i.text.includes("Vercel deploy workflow for web → static"))).toBe(true);
    expect(issues.some((i) => i.text.includes("Provision staging environment"))).toBe(true);
    expect(issues.some((i) => i.text === "Add prod health check + auto-rollback")).toBe(true);
  });

  it("flags unwired prod secrets as a blocking issue", () => {
    const d = defaultDeployConfig(["acme/web"]);
    d.services[0].platform = "vercel";
    d.config.secrets = [{ key: "DATABASE_URL", dev: true, staging: true, prod: false }];
    const issues = deployIssues(d);
    const sec = issues.find((i) => i.text.includes("Wire prod secrets"));
    expect(sec).toBeDefined();
    expect(sec!.blocking).toBe(true);
    expect(sec!.text).toContain("DATABASE_URL");
  });

  it("generates nothing service-related until a target is picked", () => {
    expect(deployIssues(defaultDeployConfig(["acme/web"])).some((i) => i.text.includes("deploy workflow"))).toBe(false);
  });
});

describe("deployConfig (#919)", () => {
  it("seeds one proposed service per repo + a default env/pipeline ladder", () => {
    const d = defaultDeployConfig(["acme/web", "acme/api"]);
    expect(d.services.map((s) => s.id)).toEqual(["web", "api"]);
    expect(d.services.every((s) => s.proposed && s.platform === "")).toBe(true);
    expect(d.envs.length).toBe(3);            // dev / staging / prod
    expect(d.pipeline.stages.length).toBe(3); // build / test / deploy
    expect(d.release.strategy).toBe("");
  });

  it("is not gate-ready out of the box (no target, no release strategy)", () => {
    const d = defaultDeployConfig(["acme/web"]);
    const checks = deployChecks(d);
    expect(checks.find((c) => c.id === "target")!.ok).toBe(false);
    expect(checks.find((c) => c.id === "release")!.ok).toBe(false);
    // envs / pipeline / secrets are satisfied by the seed
    expect(checks.find((c) => c.id === "envs")!.ok).toBe(true);
    expect(checks.find((c) => c.id === "pipeline")!.ok).toBe(true);
    expect(checks.find((c) => c.id === "secrets")!.ok).toBe(true);
    expect(deploymentDefined(d)).toBe(false);
  });

  it("deploymentDefined becomes true once every service has a target and a release strategy is chosen", () => {
    const base = defaultDeployConfig(["acme/web"]);
    const d = {
      ...base,
      services: base.services.map((s) => ({ ...s, platform: "vercel" })),
      release: { ...base.release, strategy: "rolling" as const },
    };
    expect(deploymentDefined(d)).toBe(true);
  });

  it("blocks while a prod secret is unwired", () => {
    const base = defaultDeployConfig(["acme/web"]);
    const d = {
      ...base,
      services: base.services.map((s) => ({ ...s, platform: "vercel" })),
      release: { ...base.release, strategy: "rolling" as const },
      config: { ...base.config, secrets: [{ key: "DATABASE_URL", dev: true, staging: true, prod: false }] },
    };
    expect(deploymentDefined(d)).toBe(false);
    expect(deployChecks(d).find((c) => c.id === "secrets")!.ok).toBe(false);
  });

  it("undefined config is not gate-ready", () => {
    expect(deploymentDefined(undefined)).toBe(false);
  });
});

describe("coerceDeployConfig — the planner <deploy_config> channel (#919)", () => {
  it("clears the gate from a planner-style payload", () => {
    const d = coerceDeployConfig({
      services: [{ id: "web", repo: "o/web", platform: "vercel", workload: "static" }],
      environments: [{ name: "dev", branch: "feature/*" }, { name: "staging", branch: "develop" }, { name: "prod", branch: "main" }],
      pipeline: { provider: "GitHub Actions", stages: [{ name: "build" }, { name: "test", gate: true }, { name: "deploy" }] },
      secrets: [{ key: "DATABASE_URL", envs: ["dev", "staging", "prod"] }],
      release: { strategy: "blue-green", autoRollback: true },
    });
    expect(deploymentDefined(d)).toBe(true);
    expect(d.services[0].platform).toBe("vercel");
    expect(d.envs.length).toBe(3);
    expect(d.release.strategy).toBe("blue-green");
  });

  it("blocks when a service has no platform", () => {
    const d = coerceDeployConfig({ services: [{ id: "web" }], release: { strategy: "rolling" } });
    expect(deploymentDefined(d)).toBe(false);
    expect(deployChecks(d).find((c) => c.id === "target")!.ok).toBe(false);
  });

  it("blocks when a secret omits prod from its envs", () => {
    const d = coerceDeployConfig({
      services: [{ id: "web", repo: "o/web", platform: "vercel" }],
      release: { strategy: "rolling" },
      secrets: [{ key: "X", envs: ["dev", "staging"] }],
    });
    expect(deployChecks(d).find((c) => c.id === "secrets")!.ok).toBe(false);
    expect(deploymentDefined(d)).toBe(false);
  });

  it("coerces an invalid release strategy to empty (blocks) and bad input to a safe default", () => {
    const bad = coerceDeployConfig({ services: [{ id: "web", platform: "fly" }], release: { strategy: "yolo" } });
    expect(bad.release.strategy).toBe("");
    expect(coerceDeployConfig(null).services.length).toBeGreaterThan(0); // never throws on garbage
  });

  it("parseDeployConfigTag survives stray content around the JSON (e.g. a leaked </parameter>)", () => {
    // The real-world payload that wasn't clearing the gate: 2 envs, Fly containers, secrets wired
    // for prod — but with junk inside the tag body that broke a raw JSON.parse.
    const body = `
{
  "services": [{"id":"user","repo":"o/user","platform":"fly","workload":"container"}],
  "environments": [{"name":"staging","branch":"develop"},{"name":"prod","branch":"main"}],
  "pipeline": {"provider":"GitHub Actions","stages":[{"name":"test","gate":true},{"name":"deploy"}]},
  "secrets": [{"key":"DATABASE_URL","envs":["staging","prod"]}],
  "release": {"strategy":"rolling","autoRollback":true}
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
      '  app chirp-user-{env}"}],\n' +
      '    "environments": [{"name":"staging","branch":"develop"},{"name":"prod","branch":"main"}],\n' +
      '    "pipeline": {"provider":"GitHub Actions","stages":[{"name":"test","gate":true},{"name":"deploy"}]},\n' +
      '    "secrets": [{"key":"DATABASE_URL","envs":["staging","prod"]}],\n' +
      '    "release": {"strategy":"rolling","autoRollback":true}\n' +
      '  }\n</deploy_config>';
    const body = wrapped.replace(/^<deploy_config>/, "").replace(/<\/deploy_config>$/, "");
    const cfg = parseDeployConfigTag(body);
    expect(cfg).not.toBeNull();
    expect(cfg!.services[0].platform).toBe("fly");
    expect(deploymentDefined(cfg!)).toBe(true);
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
    // a legacy cloud service still satisfies `target` via its platform
    legacy.platform = "vercel";
    expect(serviceTargetDefined(legacy)).toBe(true);
  });

  it("a local LIBRARY satisfies `target` via publish registry + package name, not a cloud platform", () => {
    const base = defaultDeployConfig(["acme/sdk"]);
    const lib = { ...base.services[0], mode: "local" as const, localKind: "library" as const, platform: "" };
    expect(localTargetDefined(lib)).toBe(false);          // nothing set yet
    expect(serviceTargetDefined(lib)).toBe(false);
    const ready = { ...lib, publishRegistry: "npm" as const, packageName: "@acme/sdk" };
    expect(localTargetDefined(ready)).toBe(true);
    expect(serviceTargetDefined(ready)).toBe(true);
    // and the whole gate clears with a release strategy, no cloud platform needed
    const d = { ...base, services: [ready], release: { ...base.release, strategy: "rolling" as const } };
    expect(deployChecks(d).find((c) => c.id === "target")!.ok).toBe(true);
    expect(deploymentDefined(d)).toBe(true);
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
    expect(finalStageName(base)).toBe("deploy");                                  // cloud
    expect(finalStageName({ ...base, mode: "local", localKind: "library" })).toBe("publish");
    expect(finalStageName({ ...base, mode: "local", localKind: "application" })).toBe("package");
    expect(finalStageName(undefined)).toBe("deploy");
  });

  it("coerceDeployConfig accepts a local library service + port forwarding", () => {
    const d = coerceDeployConfig({
      services: [
        { id: "sdk", repo: "o/sdk", mode: "local", localKind: "library", publishRegistry: "npm", packageName: "@o/sdk", publishTrigger: "on-tag" },
        { id: "cli", repo: "o/cli", mode: "local", localKind: "application", buildTargets: "linux/amd64", artifact: "cli", runCmd: "./cli",
          portForward: { enabled: true, port: "8080", method: "cloudflared" } },
      ],
      release: { strategy: "rolling" },
    });
    expect(d.services[0].mode).toBe("local");
    expect(d.services[0].localKind).toBe("library");
    expect(d.services[0].publishRegistry).toBe("npm");
    expect(d.services[0].packageName).toBe("@o/sdk");
    expect(d.services[1].localKind).toBe("application");
    expect(d.services[1].portForward).toEqual({ enabled: true, port: "8080", method: "cloudflared" });
    // both targets defined ⇒ gate clears with a release strategy and no cloud platform
    expect(deploymentDefined(d)).toBe(true);
  });

  it("coerce falls back to cloudflared for an unknown port-forward method", () => {
    const d = coerceDeployConfig({
      services: [{ id: "cli", repo: "o/cli", mode: "local", localKind: "application", buildTargets: "x", artifact: "y",
        portForward: { enabled: true, port: "9000", method: "bogus" } }],
      release: { strategy: "rolling" },
    });
    expect(d.services[0].portForward!.method).toBe("cloudflared");
  });

  it("deployIssues emits a publish workflow for a library and a package workflow for a local app", () => {
    const base = defaultDeployConfig(["o/sdk"]);
    const lib = deployIssues({ ...base, services: [{ ...base.services[0], mode: "local", localKind: "library", publishRegistry: "crates.io", packageName: "acme" }] });
    expect(lib.some((i) => i.text.includes("crates.io publish workflow"))).toBe(true);
    expect(lib.some((i) => i.text.includes("deploy workflow"))).toBe(false);
    // a library does NOT get a prod health check
    expect(lib.some((i) => i.text === "Add prod health check + auto-rollback")).toBe(false);

    const app = deployIssues({ ...base, services: [{ ...base.services[0], mode: "local", localKind: "application", buildTargets: "linux/amd64", artifact: "cli" }] });
    expect(app.some((i) => i.text.includes("package + build workflow"))).toBe(true);
    expect(app.some((i) => i.text === "Add prod health check + auto-rollback")).toBe(true);
  });
});

describe("Deploy stage placement (#919, merged into Repos #1383)", () => {
  it("the Default blueprint folds Deploy into the `repos` stage as a ship substep (no separate `deploy` section)", () => {
    const def = makeBlueprints().find((b) => b.id === "default")!;
    const keys = def.sections.map((s) => s.key);
    expect(keys).not.toContain("deploy"); // merged into repos
    const repos = def.sections.find((s) => s.key === "repos")!;
    expect(repos.substeps?.map((s) => s.key)).toEqual(["link", "ship"]);
  });
});
