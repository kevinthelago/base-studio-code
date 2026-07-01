import { describe, it, expect } from "vitest";
import {
  PLATFORMS, platform, WORKLOAD, HOSTS, hostMeta, ORCHESTRATORS, REPLICA_OPTIONS,
} from "./deployPlatforms";

// The deploy taxonomy is externalized to @data/deploy/taxonomy.json (#2027 P1). These guard that the
// data loads through the accessors unchanged — a corrupt/renamed file or a shape drift trips here.
describe("deploy taxonomy (loaded from @data/deploy/taxonomy.json)", () => {
  it("loads the platform catalog, resolving by id with kinds", () => {
    expect(PLATFORMS.length).toBe(12);
    expect(platform("ghpages").name).toBe("GitHub Pages");
    expect(platform("ghpages").kinds).toEqual(["static"]);
    expect(platform("fly").kinds).toContain("container");
    // an unknown id falls back gracefully (never throws)
    expect(platform("nope-xyz")).toMatchObject({ id: "nope-xyz", kinds: [], glyph: "■" });
  });

  it("loads workloads, git hosts, orchestrators, and replica options", () => {
    expect(WORKLOAD.container.label).toBe("container");
    expect(WORKLOAD.service.label).toBe("long-running");
    expect(hostMeta("github").domain).toBe("github.com");
    expect(hostMeta(undefined)).toBe(HOSTS.github);           // default host
    expect(hostMeta("bogus")).toBe(HOSTS.github);             // unknown → github
    expect(ORCHESTRATORS.map((o) => o.id)).toEqual(["k8s", "swarm", "nomad"]);
    expect(REPLICA_OPTIONS).toEqual(["1", "3", "5", "auto"]);
  });
});
