// The `bsc` bridge helper (#2114) — degrade-gracefully JSON parse + fire-and-forget.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { bsc, bscJson, bscRun, bscWrite } from "./bsc";

describe("bsc bridge (#2114)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("bsc passes projectKey + args straight through to the `bsc` command", async () => {
    vi.mocked(invoke).mockResolvedValue("out");
    const out = await bsc("k", ["plan", "list"]);
    expect(out).toBe("out");
    expect(invoke).toHaveBeenCalledWith("bsc", { projectKey: "k", args: ["plan", "list"] });
  });

  it("bscJson parses stdout, and returns the fallback for empty output or a rejection", async () => {
    vi.mocked(invoke).mockResolvedValue(JSON.stringify([{ id: "x" }]));
    expect(await bscJson("k", ["plan", "list"], [])).toEqual([{ id: "x" }]);

    vi.mocked(invoke).mockResolvedValue("   "); // a void verb / not-yet-created store ⇒ empty stdout
    expect(await bscJson("k", ["plan", "list"], [])).toEqual([]);

    vi.mocked(invoke).mockRejectedValue(new Error("no host"));
    expect(await bscJson("k", ["plan", "list"], [{ id: "fallback" }])).toEqual([{ id: "fallback" }]);
  });

  it("bsc omits `stdin` for reads but includes it when given", async () => {
    vi.mocked(invoke).mockResolvedValue("");
    await bsc("k", ["plan", "list"]);
    expect(invoke).toHaveBeenLastCalledWith("bsc", { projectKey: "k", args: ["plan", "list"] });
    await bsc("k", ["plan", "deps", "set"], '{"x":1}');
    expect(invoke).toHaveBeenLastCalledWith("bsc", { projectKey: "k", args: ["plan", "deps", "set"], stdin: '{"x":1}' });
  });

  it("bscWrite serializes the body onto stdin and swallows a rejection", async () => {
    vi.mocked(invoke).mockResolvedValue("");
    await bscWrite("k", ["plan", "deps", "set"], { dependencies: [], registries: {} });
    expect(invoke).toHaveBeenCalledWith("bsc", {
      projectKey: "k",
      args: ["plan", "deps", "set"],
      stdin: JSON.stringify({ dependencies: [], registries: {} }),
    });
    vi.mocked(invoke).mockRejectedValue(new Error("no host"));
    await expect(bscWrite("k", ["plan", "deps", "set"], {})).resolves.toBeUndefined();
  });

  it("bscRun fires the verb and swallows a rejection", async () => {
    vi.mocked(invoke).mockResolvedValue("");
    await bscRun("k", ["plan", "lesson", "confirm", "id1"]);
    expect(invoke).toHaveBeenCalledWith("bsc", { projectKey: "k", args: ["plan", "lesson", "confirm", "id1"] });

    vi.mocked(invoke).mockRejectedValue(new Error("no host"));
    await expect(bscRun("k", ["plan", "x"])).resolves.toBeUndefined(); // does not throw
  });
});
