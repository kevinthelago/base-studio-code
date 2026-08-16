import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { primeConfigOverrides, overlayGlob, overlayFile, resetConfigOverridesForTest } from "./configOverrides";

// A Vite eager-glob's shape: absolute-ish path → { default: value }.
const embeddedStages = {
  "/x/src-tauri/data/stages/discovery.json": { default: { name: "Discovery(embedded)" } },
  "/x/src-tauri/data/stages/deployment.json": { default: { name: "Deployment(embedded)" } },
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  resetConfigOverridesForTest();
});

describe("configOverrides", () => {
  it("falls back to embedded when nothing is primed (no Tauri backend)", () => {
    const out = Object.fromEntries(overlayGlob("stages", embeddedStages));
    expect(out.discovery.name).toBe("Discovery(embedded)");
    expect(out.deployment.name).toBe("Deployment(embedded)");
    expect(overlayFile("planner/x.json", { v: 1 })).toEqual({ v: 1 });
  });

  it("overlays a config-dir file over the embedded default, matched by stem", async () => {
    vi.mocked(invoke).mockResolvedValue({ "stages/discovery.json": '{"name":"Discovery(override)"}' });
    await primeConfigOverrides();
    const out = Object.fromEntries(overlayGlob("stages", embeddedStages));
    expect(out.discovery.name).toBe("Discovery(override)"); // override wins
    expect(out.deployment.name).toBe("Deployment(embedded)"); // untouched embedded stays
  });

  it("adds a config-dir file that is new to the surface", async () => {
    vi.mocked(invoke).mockResolvedValue({ "stages/custom.json": '{"name":"Custom"}' });
    await primeConfigOverrides();
    const out = Object.fromEntries(overlayGlob("stages", embeddedStages));
    expect(out.custom.name).toBe("Custom");
    expect(Object.keys(out)).toContain("discovery"); // embedded still present
  });

  it("IGNORES a backup file — it must not mint a second entry beside the file it backs up", async () => {
    // THE BUG. Entries key by STEM and `stem()` strips only a trailing `.json`, so the backup keys as
    // its whole filename — a different stem — and a backup of JSON is still valid JSON, so it sailed
    // through `tryParse`. In a real config dir that minted a DUPLICATE `Team architect` persona that
    // no store, no packaged data and no app-state contained.
    vi.mocked(invoke).mockResolvedValue({
      "stages/discovery.json": '{"name":"Discovery(override)"}',
      "stages/discovery.json.bak-20260813T190331Z": '{"name":"Discovery(BACKUP)"}',
    });
    await primeConfigOverrides();
    const entries = overlayGlob<{ name: string }>("stages", embeddedStages);
    const discovery = entries.filter(([, v]) => v.name.startsWith("Discovery"));
    expect(discovery).toHaveLength(1); // ONE, not one-plus-its-backup
    expect(discovery[0][1].name).toBe("Discovery(override)"); // and the real override still wins
  });

  it("ignores every backup shape the config dir actually accumulates", async () => {
    // Measured in a lived-in config dir: 43 files that are neither .json nor .md, left by editors and
    // by the app's own overlay writes. Extension-matching covers them all without a suffix blocklist.
    vi.mocked(invoke).mockResolvedValue({
      "stages/a.json.bak-20260813T190331Z": '{"name":"A"}',
      "stages/b.json.stale-bak": '{"name":"B"}',
      "stages/c.json.orig": '{"name":"C"}',
      "stages/d.json.bak-3380-20260718T152140": '{"name":"D"}',
    });
    await primeConfigOverrides();
    const out = Object.fromEntries(overlayGlob("stages", embeddedStages));
    expect(Object.keys(out).sort()).toEqual(["deployment", "discovery"]); // only the embedded pair
  });

  it("only overlays files in the requested surface dir", async () => {
    vi.mocked(invoke).mockResolvedValue({ "roles/worker.json": '{"name":"role"}' });
    await primeConfigOverrides();
    const out = Object.fromEntries(overlayGlob("stages", embeddedStages));
    expect(Object.keys(out)).toEqual(["discovery", "deployment"]); // the roles/ file is ignored here
  });

  it("overlayFile returns the parsed config-dir copy, else the embedded default", async () => {
    vi.mocked(invoke).mockResolvedValue({ "deploy/taxonomy.json": '{"platforms":["overridden"]}' });
    await primeConfigOverrides();
    expect(overlayFile("deploy/taxonomy.json", { platforms: ["embedded"] })).toEqual({ platforms: ["overridden"] });
    expect(overlayFile("deploy/absent.json", { platforms: ["embedded"] })).toEqual({ platforms: ["embedded"] });
  });

  it("keeps the embedded default when a config-dir override is invalid JSON", async () => {
    vi.mocked(invoke).mockResolvedValue({ "deploy/taxonomy.json": "{ not json" });
    await primeConfigOverrides();
    expect(overlayFile("deploy/taxonomy.json", { ok: true })).toEqual({ ok: true });
  });

  it("stays on embedded when the prime fails (e.g. IPC rejects)", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("no backend"));
    await primeConfigOverrides();
    const out = Object.fromEntries(overlayGlob("stages", embeddedStages));
    expect(out.discovery.name).toBe("Discovery(embedded)");
  });
});
