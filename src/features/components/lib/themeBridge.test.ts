// #2488: the theme bridge drives the `bsc ui theme …` verbs. These tests pin the exact argv (a verb
// typo or a regression to a different mount would be caught here, not at runtime) and the defensive
// row gate that protects the hydrate from an OLD bundled `bsc`'s lean (var-less) `list` output.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/lib/core/bsc", () => ({
  bsc: vi.fn(async () => "[]"),
  bscRun: vi.fn(async () => undefined),
  bscWrite: vi.fn(async () => undefined),
}));

import { bsc, bscRun, bscWrite } from "@/shared/lib/core/bsc";
import { loadThemes, pushTheme, dropTheme } from "./themeBridge";
import type { KitThemeRecord } from "./themes";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("themeBridge → bsc ui theme (#2488)", () => {
  it("loads themes via `bsc ui theme list --full`", async () => {
    expect(await loadThemes()).toEqual([]);
    expect(bsc).toHaveBeenCalledWith(null, ["ui", "theme", "list", "--full"]);
  });

  it("parses full rows, keeping the seed-tracking fields (#2483)", async () => {
    vi.mocked(bsc).mockResolvedValueOnce(JSON.stringify([
      { id: "soft", label: "Soft", description: "d", vars: { "--card-radius": "14px" }, builtin: true, seedHash: "abcd1234" },
    ]));
    expect(await loadThemes()).toEqual([
      { id: "soft", label: "Soft", description: "d", vars: { "--card-radius": "14px" }, builtin: true, seedHash: "abcd1234" },
    ]);
  });

  it("drops var-less rows — an OLD bsc's lean list output must not cache themes without overrides", async () => {
    vi.mocked(bsc).mockResolvedValueOnce(JSON.stringify([
      { id: "soft", label: "Soft", description: "d" }, // lean row (pre-#2488 binary ignores --full)
      { id: "ok", label: "Ok", vars: {} },
      { id: "", label: "bad", vars: {} },
    ]));
    expect(await loadThemes()).toEqual([{ id: "ok", label: "Ok", description: "", vars: {} }]);
  });

  it("returns null when the bridge is unreachable (the slice keeps its seed)", async () => {
    vi.mocked(bsc).mockRejectedValueOnce(new Error("no bridge"));
    expect(await loadThemes()).toBeNull();
  });

  it("writes theme upsert/removal through the ui surface", async () => {
    const theme = { id: "neon" } as unknown as KitThemeRecord;
    await pushTheme(theme);
    expect(bscWrite).toHaveBeenCalledWith(null, ["ui", "theme", "set"], theme);
    await dropTheme("neon");
    expect(bscRun).toHaveBeenCalledWith(null, ["ui", "theme", "remove", "neon"]);
  });
});
