import { describe, it, expect } from "vitest";
import {
  PUBLISH_REGISTRIES, PUBLISH_TRIGGERS, PORT_FORWARD_METHODS, PIPE_TRIGGERS, RELEASE_STRATEGIES,
  defaultEnvs, defaultPipeline, defaultRelease, defaultHealth,
} from "./deployEnv";

// The deploy enums + seed defaults are externalized to @data/deploy/taxonomy.json (#2027 P1). These
// guard that the data loads unchanged AND that the default builders keep their fresh-copy contract.
describe("deploy enums + defaults (loaded from @data/deploy/taxonomy.json)", () => {
  it("loads the ship-mode option lists", () => {
    expect(PUBLISH_REGISTRIES).toEqual(["npm", "crates.io", "PyPI", "internal"]);
    expect(PUBLISH_TRIGGERS).toEqual(["on-tag", "manual"]);
    expect(PORT_FORWARD_METHODS).toEqual(["cloudflared", "ngrok", "tailscale", "LAN"]);
    expect(PIPE_TRIGGERS).toEqual(["push", "tag", "on-green", "manual"]);
    expect(RELEASE_STRATEGIES.map((s) => s.id)).toEqual(["recreate", "rolling", "blue-green", "canary"]);
  });

  it("default builders return the seed shape", () => {
    expect(defaultEnvs().map((e) => e.name)).toEqual(["dev", "staging", "prod"]);
    expect(defaultPipeline().provider).toBe("GitHub Actions");
    expect(defaultPipeline().stages.find((s) => s.name === "test")!.gate).toBe(true);
    expect(defaultRelease()).toEqual({ strategy: "", autoRollback: true, keep: 3, migrateWithDeploy: false });
    expect(defaultHealth().probe).toBe("/healthz");
  });

  it("each default builder returns a FRESH deep copy — callers mutate independently", () => {
    const a = defaultEnvs();
    const b = defaultEnvs();
    expect(a).not.toBe(b); // new array each call
    a[0].name = "MUTATED";
    expect(b[0].name).toBe("dev"); // b is unaffected — no shared reference into the JSON module
    const p = defaultPipeline();
    p.stages.push({ id: "x", name: "x", trigger: "push", gate: false, cmd: "" });
    expect(defaultPipeline().stages.length).toBe(3); // the next call is unaffected
  });
});
