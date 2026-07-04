import { describe, it, expect } from "vitest";
import { DEMOABLE_KEYS, pickDemoable, snapshotAppState, isDemoableKey } from "./appState";

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
