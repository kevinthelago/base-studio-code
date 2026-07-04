import { describe, it, expect } from "vitest";
import { DEMOABLE_KEYS, pickDemoable, snapshotAppState, isDemoableKey, mergeSnapshotInto } from "./appState";

describe("app-state snapshot (#2272)", () => {
  it("snapshots only the demoable keys from a full-ish state", () => {
    const snap = snapshotAppState({
      blueprints: [{ id: "bp", name: "BP" }] as never,
      personas: [{ id: "p" }] as never,
      schedules: [{ id: "s" }] as never,
    });
    expect(Object.keys(snap).sort()).toEqual(["blueprints", "personas", "schedules"]);
  });

  it("NEVER carries a secret or the GitHub connection, even if present in the source", () => {
    const dirty = {
      githubToken: "ghp_secret",
      claudeApiKey: "sk-secret",
      openaiKey: "sk-o",
      geminiKey: "g",
      githubUser: { login: "me" },
      githubRepos: [{ full_name: "me/real" }],
      tabs: [{ id: "t" }],
      paneCwds: { p: "/c/Users/secret/path" },
      projectLocalRepos: { proj: "/c/Users/secret" },
      // a legitimately demoable field rides along
      blueprints: [{ id: "bp", name: "BP" }],
    };
    const snap = pickDemoable(dirty);
    expect(snap).toEqual({ blueprints: [{ id: "bp", name: "BP" }] });
    for (const secret of ["githubToken", "claudeApiKey", "openaiKey", "geminiKey", "githubUser", "githubRepos", "tabs", "paneCwds", "projectLocalRepos"]) {
      expect(secret in snap).toBe(false);
    }
  });

  it("drops bogus/injected keys from an untrusted payload (only known keys survive)", () => {
    const snap = pickDemoable({ personas: [{ id: "p" }], __proto__: { polluted: true }, notAKey: 1 });
    expect(Object.keys(snap)).toEqual(["personas"]);
  });

  it("tolerates non-object payloads", () => {
    expect(pickDemoable(null)).toEqual({});
    expect(pickDemoable("nope")).toEqual({});
    expect(pickDemoable(42)).toEqual({});
    expect(pickDemoable(undefined)).toEqual({});
  });

  it("skips keys that are present but undefined", () => {
    expect(pickDemoable({ blueprints: undefined, skills: [] })).toEqual({ skills: [] });
  });

  it("mergeSnapshotInto augments arrays by id, objects by key, and preserves built-ins (#2288)", () => {
    const state = {
      personas: [{ id: "director", builtin: true }, { id: "worker", builtin: true }],
      planFleet: { real: { streams: [] } },
      activeBlueprintId: "default",
    };
    const patch = mergeSnapshotInto(state, {
      personas: [{ id: "worker", builtin: true, edited: true }, { id: "demo-billing" }] as never,
      planFleet: { demoproj: { streams: [{ id: "s" }] } } as never,
      activeBlueprintId: "demo-bp" as never,
    });
    // Built-in "director" preserved; "worker" overridden by the incoming same-id; "demo-billing" added.
    expect((patch.personas as { id: string }[]).map((p) => p.id)).toEqual(["director", "worker", "demo-billing"]);
    expect((patch.personas as { edited?: boolean }[])[1].edited).toBe(true); // incoming won on the id collision
    // Map merges by key — real fleet kept, demo fleet added.
    expect(Object.keys(patch.planFleet as object).sort()).toEqual(["demoproj", "real"]);
    expect(patch.activeBlueprintId).toBe("demo-bp"); // scalar replaced
  });

  it("mergeSnapshotInto skips keys the snapshot doesn't set", () => {
    expect(mergeSnapshotInto({ personas: [{ id: "a" }] }, { blueprints: [] as never })).toEqual({ blueprints: [] });
  });

  it("isDemoableKey reflects the allowlist", () => {
    expect(isDemoableKey("blueprints")).toBe(true);
    expect(isDemoableKey("personas")).toBe(true);
    expect(isDemoableKey("githubToken")).toBe(false);
    expect(isDemoableKey("nope")).toBe(false);
  });

  it("the allowlist is free of obvious secrets/connection/machine keys", () => {
    const forbidden = [
      "githubToken", "repoGithubTokens", "claudeApiKey", "openaiKey", "geminiKey", "localBaseUrl",
      "tunnelRelayUrl", "githubConnected", "githubUser", "githubRepos", "projectLocalRepos",
      "tabs", "paneCwds", "paneRepos",
    ];
    for (const k of forbidden) expect(DEMOABLE_KEYS).not.toContain(k);
  });
});
