import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke, fireInvoke } from "./safeInvoke";

describe("safeInvoke", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("returns the resolved value on success", async () => {
    vi.mocked(invoke).mockResolvedValue(["a", "b"]);
    expect(await safeInvoke<string[]>("read_x", { limit: 5 }, [])).toEqual(["a", "b"]);
    expect(invoke).toHaveBeenCalledWith("read_x", { limit: 5 });
  });

  it("returns the fallback and observes the error on failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("nope"));
    const onError = vi.fn();
    const r = await safeInvoke<string[]>("read_x", undefined, [], onError);
    expect(r).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("fireInvoke", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("invokes with the given command + args and never throws", () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    expect(() => fireInvoke("do_x", { a: 1 })).not.toThrow();
    expect(invoke).toHaveBeenCalledWith("do_x", { a: 1 });
  });
});
