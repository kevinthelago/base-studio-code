import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { withRequirement, featureRequires, pullIntoPlan } from "./pullIntoPlan";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue("");
});

describe("withRequirement", () => {
  it("appends, preserving order", () => {
    expect(withRequirement(["merge.rs"], "bfs.rs")).toEqual(["merge.rs", "bfs.rs"]);
    expect(withRequirement(undefined, "bfs.rs")).toEqual(["bfs.rs"]);
    expect(withRequirement([], "bfs.rs")).toEqual(["bfs.rs"]);
  });

  it("never duplicates — re-pulling the same record is a no-op", () => {
    const before = ["merge.rs", "bfs.rs"];
    expect(withRequirement(before, "merge.rs")).toBe(before);
  });
});

describe("featureRequires", () => {
  it("reports what the plan already draws on", () => {
    expect(featureRequires({ requires: ["merge.rs"] }, "merge.rs")).toBe(true);
    expect(featureRequires({ requires: ["merge.rs"] }, "bfs.rs")).toBe(false);
    expect(featureRequires({ requires: undefined }, "bfs.rs")).toBe(false);
  });
});

describe("pullIntoPlan", () => {
  const feature = { slug: "geometry-kernel", requires: ["merge.rs"] };

  it("writes ONLY slug + requires, so the feature's other fields survive", async () => {
    await pullIntoPlan("proj", feature, "bfs.rs");
    expect(mockInvoke).toHaveBeenCalledWith("bsc", {
      projectKey: "proj",
      args: ["plan", "feature", "add"],
      // `feature_upsert` merges per field and preserves anything empty/absent, so name, behavior,
      // acceptance and the rest are untouched by this write.
      stdin: JSON.stringify({ slug: "geometry-kernel", requires: ["merge.rs", "bfs.rs"] }),
    });
  });

  it("does not spawn at all when the record is already required", async () => {
    const out = await pullIntoPlan("proj", feature, "merge.rs");
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(out).toEqual(["merge.rs"]);
  });

  it("seeds requires on a feature that had none", async () => {
    await pullIntoPlan("proj", { slug: "sketcher", requires: undefined }, "quick-sort.rs");
    expect(mockInvoke).toHaveBeenCalledWith("bsc", {
      projectKey: "proj",
      args: ["plan", "feature", "add"],
      stdin: JSON.stringify({ slug: "sketcher", requires: ["quick-sort.rs"] }),
    });
  });

  it("THROWS when the write fails — it must never report success without writing", async () => {
    // The defect this replaces was a button that flashed "added to the plan" and wrote nothing. The
    // `bscWrite` helper swallows errors, which is why this path deliberately does not use it.
    mockInvoke.mockRejectedValueOnce(new Error("plan store unreachable"));
    await expect(pullIntoPlan("proj", feature, "bfs.rs")).rejects.toThrow(/unreachable/);
  });
});
