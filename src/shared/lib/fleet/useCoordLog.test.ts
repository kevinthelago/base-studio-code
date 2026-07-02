import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { readCoordState } from "./useCoordLog";

// `invoke` is globally mocked in src/test/setup.ts; drive it per-test.
const ASK = "2020-01-01T00:00:00Z\tworker-a\task\tWhich pagination?\t";

describe("readCoordState", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("reads, replays, and returns the raw lines", async () => {
    // The coord read routes through the `bsc` bridge (#2144): `bsc logs tail coord --oldest` → a JSON
    // string of the raw lines on stdout, which `bscJson` parses.
    vi.mocked(invoke).mockResolvedValue(JSON.stringify([ASK]));
    const res = await readCoordState(1234);
    expect(invoke).toHaveBeenCalledWith("bsc", { projectKey: null, args: ["logs", "tail", "coord", "--limit", "1234", "--oldest", "--json"] });
    expect(res).not.toBeNull();
    expect(res!.lines).toEqual([ASK]);
    expect(res!.state.asking.length).toBe(1);
  });

  it("returns null on a read failure (so actuator loops skip the tick)", async () => {
    // A failed read (the bridge/binary rejects) surfaces as null — the helper passes it through so
    // the actuator loops keep their "skip this tick" guard.
    vi.mocked(invoke).mockRejectedValue(new Error("bridge unreachable"));
    expect(await readCoordState()).toBeNull();
  });

  it("returns a non-null empty replay for an empty log", async () => {
    // An empty log is `[]` on stdout (not empty output), so the parse yields a non-null empty result.
    vi.mocked(invoke).mockResolvedValue(JSON.stringify([]));
    const res = await readCoordState();
    expect(res).not.toBeNull();
    expect(res!.state.asking).toEqual([]);
    expect(res!.lines).toEqual([]);
  });
});
