import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  studioToManifest, manifestToStudio, exportStudioToGist, importStudioFromGist, STUDIO_KIND, type Studio,
} from "./studioGist";
import { validateManifest, type ExtensionManifest } from "@/features/planner";

const studio: Studio = {
  id: "my-studio",
  name: "My Studio",
  description: "a snapshot",
  version: "1.2.0",
  snapshot: {
    blueprints: [{ id: "bp1", name: "Full-stack" }],
    teams: [{ id: "t1", name: "Core" }],
    personas: [],
  },
};

describe("studio gist envelope (#2891 slice 2)", () => {
  it("round-trips a studio through the manifest", () => {
    const m = studioToManifest(studio);
    expect(m.kind).toBe(STUDIO_KIND);
    expect(m.version).toBe("1.2.0");
    expect(validateManifest(m).ok).toBe(true);
    const r = manifestToStudio(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.studio.id).toBe("my-studio");
    expect(r.studio.name).toBe("My Studio");
    expect(r.studio.description).toBe("a snapshot");
    expect(r.studio.version).toBe("1.2.0");
    expect(r.studio.snapshot.blueprints).toEqual([{ id: "bp1", name: "Full-stack" }]);
    expect(r.studio.snapshot.teams).toEqual([{ id: "t1", name: "Core" }]);
    expect(r.studio.snapshot.personas).toEqual([]);
  });

  it("defaults the manifest version to 1.0.0 when the studio has none", () => {
    const noVersion: Studio = { id: "s", name: "S", snapshot: {} };
    const m = studioToManifest(noVersion);
    expect(m.version).toBe("1.0.0");
    const r = manifestToStudio(m);
    // The payload carried no version, so the reconstruction falls back to the envelope's (the
    // authoritative version string) — a studio always ends up versioned.
    expect(r.ok && r.studio.version).toBe("1.0.0");
    // Description, by contrast, is absent from BOTH payload and envelope ⇒ stays absent (never
    // a fabricated value).
    expect(r.ok && r.studio.description).toBeUndefined();
  });

  it("rejects a non-studio manifest", () => {
    const bp = { manifest: 1, kind: "blueprint", id: "b", name: "B", version: "1", payload: {} } as unknown as ExtensionManifest;
    const r = manifestToStudio(bp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("expected a studio");
  });

  it("rejects a malformed payload (no id/name anywhere)", () => {
    // Empty envelope id/name + empty payload ⇒ nothing to key/identify a studio by.
    const empty = { manifest: 1, kind: STUDIO_KIND, id: "", name: "", version: "1", payload: {} } as unknown as ExtensionManifest;
    const r = manifestToStudio(empty);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("malformed");
    // A payload missing id/name falls back to the ENVELOPE id/name (still a valid studio).
    const fallback = { manifest: 1, kind: STUDIO_KIND, id: "env-id", name: "Env Name", version: "1", payload: {} } as unknown as ExtensionManifest;
    const r2 = manifestToStudio(fallback);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.studio.id).toBe("env-id");
      expect(r2.studio.name).toBe("Env Name");
    }
  });

  it("coerces a malformed snapshot to {} (never trusts the payload shape)", () => {
    const bad = { manifest: 1, kind: STUDIO_KIND, id: "s", name: "S", version: "1", payload: { id: "s", name: "S", snapshot: "not an object" } } as unknown as ExtensionManifest;
    const r = manifestToStudio(bad);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.studio.snapshot).toEqual({});
    // An array snapshot (what JSON.parse yields for `[]`) also coerces to {}.
    const arr = { manifest: 1, kind: STUDIO_KIND, id: "s", name: "S", version: "1", payload: { id: "s", name: "S", snapshot: [] } } as unknown as ExtensionManifest;
    const r2 = manifestToStudio(arr);
    expect(r2.ok && r2.studio.snapshot).toEqual({});
    // Non-array snapshot VALUES are dropped; array values survive.
    const mixed = { manifest: 1, kind: STUDIO_KIND, id: "s", name: "S", version: "1", payload: { id: "s", name: "S", snapshot: { good: [1], bad: 7 } } } as unknown as ExtensionManifest;
    const r3 = manifestToStudio(mixed);
    expect(r3.ok && r3.studio.snapshot).toEqual({ good: [1] });
  });
});

describe("studio gist transport (#2891 slice 2)", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it("exportStudioToGist publishes the manifest via gist_create with the right shape", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "gist_create") return { id: "0123456789abcdef", html_url: "https://gist.github.com/me/0123456789abcdef" };
      return null;
    });
    const res = await exportStudioToGist(studio, "tok", { public: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.id).toBe("0123456789abcdef");
    expect(res.url).toBe("https://gist.github.com/me/0123456789abcdef");
    // gist_create got the studio manifest as a single extension.json file + the token + public flag.
    const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "gist_create")!;
    const payload = call[1] as { token: string; files: Record<string, string>; description: string; public: boolean };
    expect(payload.token).toBe("tok");
    expect(payload.public).toBe(true);
    expect(payload.description).toBe(`${STUDIO_KIND}: My Studio`);
    const wrote = JSON.parse(payload.files["extension.json"]) as ExtensionManifest;
    expect(wrote.kind).toBe(STUDIO_KIND);
    expect(manifestToStudio(wrote).ok).toBe(true);
  });

  it("exportStudioToGist surfaces a publish failure as { ok: false }", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "gist_create") throw new Error("no gist scope");
      return null;
    });
    const res = await exportStudioToGist(studio, "tok");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no gist scope");
  });

  it("importStudioFromGist fetches via github_request and reconstructs the studio", async () => {
    const manifestText = JSON.stringify(studioToManifest(studio), null, 2);
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "github_request") {
        const path = (args as { path: string }).path;
        expect(path).toContain("gists/0123456789abcdef");
        return { id: "0123456789abcdef", files: { "extension.json": { content: manifestText } } };
      }
      return null;
    });
    const res = await importStudioFromGist("https://gist.github.com/me/0123456789abcdef", "tok");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.studio.id).toBe("my-studio");
    expect(res.studio.name).toBe("My Studio");
    expect(res.studio.snapshot.blueprints).toEqual([{ id: "bp1", name: "Full-stack" }]);
  });

  it("importStudioFromGist rejects a gist carrying a non-studio manifest", async () => {
    const bp = JSON.stringify({ manifest: 1, kind: "blueprint", id: "b", name: "B", version: "1", payload: {} });
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "github_request") return { id: "abcabcabc123", files: { "extension.json": { content: bp } } };
      return null;
    });
    const res = await importStudioFromGist("abcabcabc123");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("expected a studio");
  });
});
