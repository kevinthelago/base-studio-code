import { describe, it, expect } from "vitest";
import {
  runtimeFaultAdapters,
  selectAdapter,
  isImplemented,
  shimLanguages,
  renderShim,
  runtimeFaultRegistry,
} from "./runtimeFault";

// #2262: the per-environment runtime-fault adapter registry loads, adapter selection reflects
// implemented-vs-planned, and the local shim renders with the per-project values substituted (no
// leftover placeholders) — the acceptance tests for the "instrumentation as a natural part of
// generation" slice of epic #2258.
describe("runtime-fault adapters (@data/runtime-fault/adapters.json)", () => {
  it("loads the registry with local implemented + the cloud envs present as explicit 'planned' seams", () => {
    const adapters = runtimeFaultAdapters();
    expect(adapters.local?.status).toBe("implemented");
    // No silent omission: every declared cloud environment is present, marked planned.
    for (const env of ["aws", "vercel", "fly", "docker"]) {
      expect(adapters[env]?.status).toBe("planned");
    }
    expect(runtimeFaultRegistry().heartbeatSeconds).toBeGreaterThan(0);
  });

  it("selects an adapter and reports whether its instrumentation is built", () => {
    expect(selectAdapter("local")?.transport).toBe("localhost-post");
    expect(isImplemented("local")).toBe(true);
    expect(isImplemented("aws")).toBe(false); // declared but planned
    expect(selectAdapter("nope")).toBeUndefined();
    expect(isImplemented("nope")).toBe(false);
  });

  it("exposes the shim languages the local env ships (and none for a planned/unknown env)", () => {
    const langs = shimLanguages("local");
    for (const lang of ["js", "ts", "python", "rust", "go"]) expect(langs).toContain(lang);
    expect(shimLanguages("aws")).toEqual([]);
    expect(shimLanguages("nope")).toEqual([]);
  });

  it("renders the local shim with port/token/release/project substituted and no leftover placeholders", () => {
    const vars = { ingestPort: 54321, projectKey: "p-abc-123", ingestToken: "deadbeefcafef00d", release: "commit-9f3a" };
    const shim = renderShim("local", "js", vars);
    expect(shim).not.toBeNull();
    const s = shim as string;
    // The baked values are present…
    expect(s).toContain("http://127.0.0.1:54321/ingest");
    expect(s).toContain("p-abc-123");
    expect(s).toContain("deadbeefcafef00d");
    expect(s).toContain("commit-9f3a");
    // …and NO template placeholder survived (a literal {{…}} would be a silently-broken shim).
    expect(s).not.toMatch(/\{\{\w+\}\}/);
    // The heartbeat cadence is derived (ms) from the registry seconds.
    expect(s).toContain(String(runtimeFaultRegistry().heartbeatSeconds * 1000));
  });

  it("renders every implemented stack language with its port substituted", () => {
    const vars = { ingestPort: 6000, projectKey: "k", ingestToken: "t", release: "r" };
    for (const lang of ["ts", "python", "rust", "go"]) {
      const s = renderShim("local", lang, vars);
      expect(s, `shim for ${lang}`).not.toBeNull();
      expect(s as string).toContain("6000");
      expect(s as string).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it("returns null for a planned env or an unknown language (graceful degrade, no throw)", () => {
    const vars = { ingestPort: 1, projectKey: "k", ingestToken: "t", release: "r" };
    expect(renderShim("aws", "js", vars)).toBeNull(); // planned adapter has no shim
    expect(renderShim("local", "cobol", vars)).toBeNull(); // language the adapter doesn't cover
    expect(renderShim("nope", "js", vars)).toBeNull(); // unknown env
  });
});
