import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the generic `bsc` bridge (mirrors graphBridge.test.ts): the read routes through `bscJson`, the
// writes through `bscWrite`/`bscRun`.
const bscJson = vi.fn();
const bscWrite = vi.fn();
const bscRun = vi.fn();
vi.mock("@/shared/lib/core/bsc", () => ({
  bscJson: (...a: unknown[]) => bscJson(...a),
  bscWrite: (...a: unknown[]) => bscWrite(...a),
  bscRun: (...a: unknown[]) => bscRun(...a),
}));

import { listDbProjects, addDbProject, removeDbProject, setDbProjectState } from "./projectsDbBridge";

describe("projectsDbBridge.listDbProjects (#2995)", () => {
  beforeEach(() => { bscJson.mockReset(); bscWrite.mockReset(); bscRun.mockReset(); });

  it("parses a valid `bsc project db list` array and shape-gates each row", async () => {
    bscJson.mockResolvedValue([
      { key: "my-app", title: "My App", pitch: "p", blueprint: "default", category: "greenfield", state: "drafted", createdAt: 1, updatedAt: 2 },
      { key: "", title: "no key" }, // dropped — empty key
      { title: "keyless" },         // dropped — no key
      { key: "no-state", title: "x" }, // dropped — no state
    ]);
    const rows = await listDbProjects();
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({ key: "my-app", title: "My App", state: "drafted", blueprint: "default", category: "greenfield" });
    expect(bscJson).toHaveBeenCalledWith(null, ["project", "db", "list", "--json"], null);
  });

  it("coerces null blueprint/category and missing numeric fields to safe defaults", async () => {
    bscJson.mockResolvedValue([{ key: "k", title: "T", state: "planning", blueprint: null, category: null }]);
    const rows = await listDbProjects();
    expect(rows![0]).toMatchObject({ key: "k", pitch: "", blueprint: null, category: null, createdAt: 0, updatedAt: 0 });
  });

  it("returns null when the payload isn't an array (degraded → keep the cache)", async () => {
    bscJson.mockResolvedValue({ nope: true });
    expect(await listDbProjects()).toBeNull();
  });

  it("returns null when the bridge yields null (unreachable / old bsc without the verb)", async () => {
    bscJson.mockResolvedValue(null);
    expect(await listDbProjects()).toBeNull();
  });

  it("returns null when the bridge throws", async () => {
    bscJson.mockRejectedValue(new Error("no bridge"));
    expect(await listDbProjects()).toBeNull();
  });
});

describe("projectsDbBridge write helpers (#2995)", () => {
  beforeEach(() => { bscJson.mockReset(); bscWrite.mockReset(); bscRun.mockReset(); });

  it("add sends the JSON object on stdin via `bsc project db add`", async () => {
    const p = { key: "k", title: "T", pitch: "p", blueprint: "default", category: "greenfield", state: "drafted" };
    await addDbProject(p);
    expect(bscWrite).toHaveBeenCalledWith(null, ["project", "db", "add"], p);
  });

  it("remove + state fire the positional verbs", async () => {
    await removeDbProject("k");
    expect(bscRun).toHaveBeenCalledWith(null, ["project", "db", "remove", "k"]);
    await setDbProjectState("k", "published");
    expect(bscRun).toHaveBeenCalledWith(null, ["project", "db", "state", "k", "published"]);
  });
});
