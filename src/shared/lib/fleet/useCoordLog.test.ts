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

  it("returns null on an unusable read (so actuator loops skip the tick)", async () => {
    // An unusable read (empty stdout / the bridge produced nothing) → bscJson's null fallback → null,
    // so the actuator loops keep their "skip this tick" guard. (Driven via an empty read rather than a
    // raw reject: a rejection routed through the extra async frame trips vitest's unhandled-rejection
    // guard before the catch attaches; the reject path itself is covered directly in bsc.test.ts.)
    vi.mocked(invoke).mockResolvedValue("");
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
