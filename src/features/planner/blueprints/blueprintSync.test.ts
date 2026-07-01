import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { toRevisions, gistRevisions, installFromGistRevision } from "@/features/planner/lib/gist/gist";

describe("gist revisions (#598 follow-up)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("toRevisions maps the gist history (newest first), defaulting missing fields", () => {
    const revs = toRevisions([
      { version: "abc123", committed_at: "2026-06-01T10:00:00Z", change_status: { additions: 12, deletions: 3 }, user: { login: "kev" } },
      { version: "def456" },
    ]);
    expect(revs).toEqual([
      { version: "abc123", committedAt: "2026-06-01T10:00:00Z", additions: 12, deletions: 3, login: "kev" },
      { version: "def456", committedAt: "", additions: 0, deletions: 0, login: "unknown" },
    ]);
  });

  it("gistRevisions fetches + maps; returns [] on error", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ history: [{ version: "v1", user: { login: "a" } }] });
    expect(await gistRevisions("gid", "tok")).toEqual([{ version: "v1", committedAt: "", additions: 0, deletions: 0, login: "a" }]);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("boom"));
    expect(await gistRevisions("gid")).toEqual([]);
  });

  it("installFromGistRevision pulls the manifest at a revision", async () => {
    const manifest = { manifest: 1, kind: "blueprint", id: "x", name: "X", version: "1.0.0", payload: { id: "x", name: "X", sections: [{ key: "discovery", name: "Discovery" }] } };
    vi.mocked(invoke).mockResolvedValueOnce({ files: { "extension.json": { content: JSON.stringify(manifest) } } });
    const res = await installFromGistRevision("gid", "sha", "tok");
    expect(res.ok).toBe(true);
  });
});
