import { describe, it, expect } from "vitest";
import { defaultDeployConfig, deployChecks, deploymentDefined, coerceDeployConfig, parseDeployConfigTag } from "../screens/planner/shared/deployConfig";
import { makeBlueprints } from "../screens/planner/blueprints";

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

describe("Deploy stage placement (#919)", () => {
  it("the Default blueprint includes `deploy` immediately after `repos`", () => {
    const def = makeBlueprints().find((b) => b.id === "default")!;
    const keys = def.sections.map((s) => s.key);
    expect(keys).toContain("deploy");
    expect(keys[keys.indexOf("repos") + 1]).toBe("deploy");
  });
});
