import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { readCoordState } from "./useCoordLog";

// `invoke` is globally mocked in src/test/setup.ts; drive it per-test.
const ASK = "2020-01-01T00:00:00Z\tworker-a\task\tWhich pagination?\t";

describe("readCoordState", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("reads, replays, and returns the raw lines", async () => {
    vi.mocked(invoke).mockResolvedValue([ASK]);
    const res = await readCoordState(1234);
    expect(invoke).toHaveBeenCalledWith("read_coord_log", { limit: 1234 });
    expect(res).not.toBeNull();
    expect(res!.lines).toEqual([ASK]);
    expect(res!.state.asking.length).toBe(1);
  });

  it("returns null on a read failure (so actuator loops skip the tick)", async () => {
    // A failed read surfaces as null lines (invoke's .catch(() => null)); the helper passes it
    // through as null so the actuator loops keep their "skip this tick" guard.
    vi.mocked(invoke).mockResolvedValue(null);
    expect(await readCoordState()).toBeNull();
  });

  it("returns a non-null empty replay for an empty log", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    const res = await readCoordState();
    expect(res).not.toBeNull();
    expect(res!.state.asking).toEqual([]);
    expect(res!.lines).toEqual([]);
  });
});
