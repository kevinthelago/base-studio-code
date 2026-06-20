import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { toRevisions, gistRevisions, installFromGistRevision } from "../lib/extensions/gist";
import { diffBlueprints } from "../screens/planner/blueprints/blueprintDiff";
import { mkStageSection } from "../screens/planner/blueprints/blueprintEdit";
import { setStageField } from "../screens/planner/blueprints/blueprintEdit";
import type { Blueprint } from "../screens/planner/blueprints";

const bp = (sections: ReturnType<typeof mkStageSection>[]): Blueprint => ({ id: "b", name: "B", desc: "d", sections });

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
    const manifest = { manifest: 1, kind: "blueprint", id: "x", name: "X", version: "1.0.0", payload: { id: "x", name: "X", sections: [{ key: "context", name: "Context" }] } };
    vi.mocked(invoke).mockResolvedValueOnce({ files: { "extension.json": { content: JSON.stringify(manifest) } } });
    const res = await installFromGistRevision("gid", "sha", "tok");
    expect(res.ok).toBe(true);
  });
});

describe("diffBlueprints (#598 follow-up)", () => {
  it("flags add / del / mod by section key, and nothing when identical", () => {
    const local = bp([mkStageSection("context"), mkStageSection("ui")]);
    // upstream: context edited, ui dropped, api added
    let upSections = [mkStageSection("context"), mkStageSection("api")];
    upSections = setStageField(upSections, upSections[0].uid, { prompt: "different prompt" });
    const upstream = bp(upSections);

    const diff = diffBlueprints(local, upstream);
    expect(diff.find((d) => d.type === "mod" && d.title === upSections[0].name)).toBeTruthy(); // context changed
    expect(diff.find((d) => d.type === "add")).toMatchObject({ type: "add" }); // api added
    expect(diff.find((d) => d.type === "del")).toMatchObject({ type: "del" }); // ui removed
  });

  it("returns no diff for identical blueprints", () => {
    const a = bp([mkStageSection("context"), mkStageSection("structure")]);
    const b = bp(a.sections.map((s) => ({ ...s, uid: "x" + s.uid }))); // same content, different uids
    expect(diffBlueprints(a, b)).toEqual([]);
  });
});
