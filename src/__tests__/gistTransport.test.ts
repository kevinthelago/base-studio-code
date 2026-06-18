import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { gistIdFromUrl, pickManifestContent, publishGist, updateGist, installFromGist, MANIFEST_FILENAME } from "../lib/extensions/gist";
import { wrapExtension } from "../lib/extensions/manifest";

describe("gist transport — pure helpers (#598)", () => {
  it("extracts a gist id from URLs, api URLs, and bare ids", () => {
    expect(gistIdFromUrl("https://gist.github.com/kevin/0123456789abcdef")).toBe("0123456789abcdef");
    expect(gistIdFromUrl("https://gist.github.com/0123456789abcdef")).toBe("0123456789abcdef");
    expect(gistIdFromUrl("https://api.github.com/gists/0123456789abcdef")).toBe("0123456789abcdef");
    expect(gistIdFromUrl("0123456789abcdef")).toBe("0123456789abcdef");
    expect(gistIdFromUrl("not a gist")).toBeNull();
    expect(gistIdFromUrl("")).toBeNull();
  });

  it("picks the manifest file (named first, else first .json)", () => {
    expect(pickManifestContent({ [MANIFEST_FILENAME]: { content: "A", filename: MANIFEST_FILENAME } })).toBe("A");
    expect(pickManifestContent({ "other.json": { content: "B", filename: "other.json" } })).toBe("B");
    expect(pickManifestContent({ "readme.md": { content: "C", filename: "readme.md" } })).toBeNull();
    expect(pickManifestContent(undefined)).toBeNull();
  });
});

describe("gist transport — invoke-backed (#598)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("publishGist sends the manifest file and returns id + url", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ id: "gid", html_url: "https://gist.github.com/u/gid", files: {} });
    const m = wrapExtension("blueprint", "bp", "My BP", "1.0.0", { x: 1 });
    const res = await publishGist("tok", m, { description: "d" });
    expect(res).toEqual({ id: "gid", htmlUrl: "https://gist.github.com/u/gid" });
    const [cmd, args] = vi.mocked(invoke).mock.calls[0];
    expect(cmd).toBe("gist_create");
    expect((args as { files: Record<string, string> }).files[MANIFEST_FILENAME]).toContain("\"id\": \"bp\"");
    expect((args as { public: boolean }).public).toBe(false); // secret by default
  });

  it("updateGist PATCHes an existing gist by id and returns id + url (#970)", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ id: "gid", html_url: "https://gist.github.com/u/gid", files: {} });
    const m = wrapExtension("blueprint", "bp", "My BP", "1.0.0", { x: 2 });
    const res = await updateGist("tok", "gid", m, { description: "d2" });
    expect(res).toEqual({ id: "gid", htmlUrl: "https://gist.github.com/u/gid" });
    const [cmd, args] = vi.mocked(invoke).mock.calls[0];
    expect(cmd).toBe("gist_update");                                  // updates in place, not gist_create
    expect((args as { id: string }).id).toBe("gid");
    expect((args as { files: Record<string, string> }).files[MANIFEST_FILENAME]).toContain("\"id\": \"bp\"");
    expect((args as Record<string, unknown>).public).toBeUndefined(); // visibility is fixed on update
  });

  it("installFromGist fetches the gist and validates its manifest", async () => {
    const m = wrapExtension("blueprint", "bp", "My BP", "1.0.0", { x: 1 });
    vi.mocked(invoke).mockResolvedValueOnce({
      id: "gid", files: { [MANIFEST_FILENAME]: { content: JSON.stringify(m), filename: MANIFEST_FILENAME } },
    });
    const res = await installFromGist("https://gist.github.com/u/0123456789abcdef");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.manifest.id).toBe("bp");
  });

  it("installFromGist rejects a bad ref and a gist with no manifest", async () => {
    expect((await installFromGist("nonsense")).ok).toBe(false);
    vi.mocked(invoke).mockResolvedValueOnce({ id: "gid", files: { "readme.md": { content: "hi", filename: "readme.md" } } });
    expect((await installFromGist("0123456789abcdef")).ok).toBe(false);
  });
});
