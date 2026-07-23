import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { readCoordState } from "./useCoordLog";

// `invoke` is globally mocked in src/test/setup.ts; drive it per-test.
const ASK = "2020-01-01T00:00:00Z\tworker-a\task\tWhich pagination?\t";

describe("readCoordState", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("reads (in-process), replays, and returns the raw lines", async () => {
    // #3630: the coord read is the in-process `logs_tail` command, which returns the raw lines ARRAY
    // directly (not a JSON string over the `bsc` bridge). `oldest: true` keeps chronological order.
    vi.mocked(invoke).mockResolvedValue([ASK]);
    const res = await readCoordState(1234);
    expect(invoke).toHaveBeenCalledWith("logs_tail", { stream: "coord", limit: 1234, oldest: true });
    expect(res).not.toBeNull();
    expect(res!.lines).toEqual([ASK]);
    expect(res!.state.asking.length).toBe(1);
  });

  it("returns null on a read failure (so actuator loops skip the tick)", async () => {
    // A failed read → `logsTail`'s `null` fallback (safeInvoke swallows the rejection) → null, so the
    // actuator loops keep their "skip this tick" guard. An empty log is distinct — it replays to a
    // non-null empty result (below).
    vi.mocked(invoke).mockRejectedValueOnce(new Error("bridge down"));
    expect(await readCoordState()).toBeNull();
  });

  it("returns a non-null empty replay for an empty log", async () => {
    // An empty log is `[]` (a present-but-empty array), so the replay yields a non-null empty result.
    vi.mocked(invoke).mockResolvedValue([]);
    const res = await readCoordState();
    expect(res).not.toBeNull();
    expect(res!.state.asking).toEqual([]);
    expect(res!.lines).toEqual([]);
  });
});
