import { describe, it, expect } from "vitest";
import { defaultDeployConfig, deployChecks, deploymentDefined } from "../screens/projects/deployConfig";
import { makeBlueprints } from "../screens/projects/blueprints";

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

describe("Deploy stage placement (#919)", () => {
  it("the Default blueprint includes `deploy` immediately after `repos`", () => {
    const def = makeBlueprints().find((b) => b.id === "default")!;
    const keys = def.sections.map((s) => s.key);
    expect(keys).toContain("deploy");
    expect(keys[keys.indexOf("repos") + 1]).toBe("deploy");
  });
});
