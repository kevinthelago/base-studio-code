import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the `bsc` bridge so the generator calls resolve to canned `bsc ui generate next` output.
vi.mock("@/shared/lib/core/bsc", () => ({ bsc: vi.fn(async () => "{}") }));
import { bsc } from "@/shared/lib/core/bsc";
import { generateCategoryColors } from "./designGenBridge";

describe("generateCategoryColors (#2658)", () => {
  beforeEach(() => vi.mocked(bsc).mockReset());

  it("maps each missing category to a generated colour, in order", async () => {
    vi.mocked(bsc)
      .mockResolvedValueOnce(JSON.stringify({ hue: 190, color: "oklch(0.72 0.15 190)" }))
      .mockResolvedValueOnce(JSON.stringify({ hue: 300, color: "oklch(0.72 0.15 300)" }));
    const out = await generateCategoryColors(["simulation", "analysis"]);
    expect(out).toEqual({
      simulation: "oklch(0.72 0.15 190)",
      analysis: "oklch(0.72 0.15 300)",
    });
    expect(vi.mocked(bsc)).toHaveBeenCalledTimes(2);
    // Each call is `bsc ui generate next --existing <hues>` on the global (null) scope.
    const [scope, args] = vi.mocked(bsc).mock.calls[0];
    expect(scope).toBeNull();
    expect(args.slice(0, 4)).toEqual(["ui", "generate", "next", "--existing"]);
  });

  it("feeds each freshly-placed hue back into the next call's --existing set (no self-collision)", async () => {
    vi.mocked(bsc)
      .mockResolvedValueOnce(JSON.stringify({ hue: 190, color: "#aaa" }))
      .mockResolvedValueOnce(JSON.stringify({ hue: 300, color: "#bbb" }));
    await generateCategoryColors(["a", "b"]);
    const firstExisting = vi.mocked(bsc).mock.calls[0][1][4];
    const secondExisting = vi.mocked(bsc).mock.calls[1][1][4];
    // The second call's used-set is the first's plus the hue placed for "a" (190).
    expect(secondExisting.split(",")).toEqual([...firstExisting.split(","), "190"]);
  });

  it("falls LOUDLY — throws when the generator is unreachable (no silent hole)", async () => {
    vi.mocked(bsc).mockRejectedValueOnce(new Error("bsc binary not found"));
    await expect(generateCategoryColors(["simulation"])).rejects.toThrow(/bsc binary not found/);
  });

  it("falls LOUDLY — throws on an unexpected generator shape", async () => {
    vi.mocked(bsc).mockResolvedValueOnce(JSON.stringify({ nope: true }));
    await expect(generateCategoryColors(["simulation"])).rejects.toThrow(/unexpected shape/);
  });

  it("returns {} for no missing categories without calling the generator", async () => {
    expect(await generateCategoryColors([])).toEqual({});
    expect(vi.mocked(bsc)).not.toHaveBeenCalled();
  });
});
