// The coordination fold is served by RUST, and the ways it can fail stay distinguishable
// (`the-coordination-state-is-folded-twice-and-only-the-renderer-copy-is-live`).
//
// What is worth pinning is not that the read works. It is that three outcomes stay three:
//
//   1. Rust answered            → the app shows Rust's fold.
//   2. Rust could not answer    → the app shows the RENDERER's fold, freshly computed. Not the last
//                                 good one, and not nothing: coordination state is what tells an
//                                 operator a session is waiting on them, and a stale or blank answer
//                                 hides a human-blocked worker.
//   3. Neither could read       → `null`, so an actuator skips a tick without clearing its own state.
//
// EVERY CASE IS BUILT SO THE TWO IMPLEMENTATIONS DISAGREE. If the Rust answer and a renderer fold of
// the same lines were equal, every test here would pass whichever source was consulted and the suite
// would prove nothing about the migration it exists to guard.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { readCoordState, coordStateDigest } from "@/shared/lib/fleet/useCoordLog";
import { ingestCoordLog, emptyCoordState } from "@/shared/lib/fleet/coordination";

type InvokePayload = { limit: number; observed: unknown };

const coordCalls = (): InvokePayload[] =>
  vi.mocked(invoke).mock.calls
    .filter(([cmd]) => cmd === "logs_coord")
    .map(([, payload]) => payload as InvokePayload);

const tailCalls = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "logs_tail");

/** A line the RENDERER fold would place in `asking`, so a renderer answer is recognisable. */
const ASK_LINE = "2026-08-31T12:00:01Z\tproj:api\task\twhich pagination?\t";

/** Rust's answer. Deliberately NOT what folding `lines` would produce — `lines` is empty here, so a
 *  renderer fold of it is empty, and any non-empty state can only have come from Rust. */
function rustRead(over: Record<string, unknown> = {}) {
  return {
    state: { ...emptyCoordState(), asking: [{ session: "proj:only-rust-knows", question: "q", at: 1 }] },
    woken: [],
    ready: [],
    answered: [],
    assigned: [],
    refused: [],
    lines: [] as string[],
    digest: ["asking:proj:only-rust-knows"],
    ...over,
  };
}

/** Route each command to its own answer, so a test can fail ONE of them. */
function route(handlers: Record<string, unknown>) {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (!(cmd in handlers)) return Promise.resolve(undefined as never);
    const v = handlers[cmd];
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v as never);
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  // The comparison cell is anchored on `globalThis` so it survives a remount; reset it between tests
  // or the cadence assertions inherit the previous test's clock.
  delete (globalThis as unknown as Record<string, unknown>).__bscCoordCompare;
});

describe("readCoordState is served by the Rust fold", () => {
  it("asks logs_coord and returns RUST's fold, not a renderer replay of the same lines", async () => {
    route({ logs_coord: rustRead() });

    const res = await readCoordState(1000);

    expect(coordCalls()).toHaveLength(1);
    expect(coordCalls()[0].limit).toBe(1000);
    // The state could not have been produced by folding `lines` ([] → empty), so this IS the flip.
    expect(res?.source).toBe("rust");
    expect(res?.state.asking.map((a) => a.session)).toEqual(["proj:only-rust-knows"]);
    expect(ingestCoordLog([], emptyCoordState()).state.asking).toEqual([]);
    // And it did NOT fall back to reading the tail itself.
    expect(tailCalls()).toHaveLength(0);
  });

  it("still returns the RAW LINES, which the result type promises its readers", async () => {
    route({ logs_coord: rustRead({ lines: ["a", "b"] }) });
    expect((await readCoordState())?.lines).toEqual(["a", "b"]);
  });

  it("does not spawn a process: the read is one in-process invoke, never the bsc bridge", async () => {
    route({ logs_coord: rustRead() });
    await readCoordState();
    // `bsc` is the subprocess bridge. Reaching it here would be the per-poll spawn regression.
    expect(vi.mocked(invoke).mock.calls.map(([cmd]) => cmd)).toEqual(["logs_coord"]);
  });
});

describe("the three answers stay three", () => {
  it("an EMPTY log is present-but-empty, never null", async () => {
    route({
      logs_coord: { state: emptyCoordState(), woken: [], ready: [], answered: [], assigned: [], refused: [], lines: [], digest: [] },
    });

    const res = await readCoordState();

    expect(res).not.toBeNull();
    expect(res?.state.asking).toEqual([]);
    expect(res?.lines).toEqual([]);
  });

  it("falls back to the RENDERER fold when the Rust read could not run — freshly computed, not stale", async () => {
    route({ logs_coord: new Error("no such command"), logs_tail: [ASK_LINE] });

    const res = await readCoordState();

    expect(res?.source).toBe("renderer");
    // Folded from the lines it read, so the operator still sees the parked session.
    expect(res?.state.asking.map((a) => a.session)).toEqual(["proj:api"]);
    expect(tailCalls()).toHaveLength(1);
  });

  it("returns null ONLY when neither implementation could read the log", async () => {
    route({ logs_coord: new Error("down"), logs_tail: new Error("down") });
    expect(await readCoordState()).toBeNull();
  });

  it("nothing latches: a failed read is not remembered, and the next read answers normally", async () => {
    route({ logs_coord: new Error("down"), logs_tail: new Error("down") });
    expect(await readCoordState()).toBeNull();

    route({ logs_coord: rustRead() });
    const res = await readCoordState();

    expect(res?.source).toBe("rust");
    expect(res?.state.asking.map((a) => a.session)).toEqual(["proj:only-rust-knows"]);
  });
});

describe("the two folds are compared, and the comparison is recorded", () => {
  it("sends nothing on the first read, then piggy-backs the comparison on the NEXT one", async () => {
    route({ logs_coord: rustRead({ lines: [ASK_LINE] }) });

    await readCoordState();
    expect(coordCalls()[0].observed).toBeNull();

    await readCoordState();
    const observed = coordCalls()[1].observed as { rust: string[]; caller: string[] };
    // Rust's digest as returned, and the renderer's digest of THE SAME LINES.
    expect(observed.rust).toEqual(["asking:proj:only-rust-knows"]);
    expect(observed.caller).toEqual(["asking:proj:api"]);
  });

  it("costs no extra invoke — the comparison rides on a read that was happening anyway", async () => {
    route({ logs_coord: rustRead() });
    await readCoordState();
    await readCoordState();
    expect(coordCalls()).toHaveLength(2);
    expect(vi.mocked(invoke).mock.calls).toHaveLength(2);
  });

  it("reports an OUTAGE as uncomparable rather than letting it read as agreement", async () => {
    route({ logs_coord: new Error("down"), logs_tail: [ASK_LINE] });
    await readCoordState();

    route({ logs_coord: rustRead() });
    await readCoordState();

    const observed = coordCalls()[coordCalls().length - 1].observed as { uncomparable?: string };
    expect(observed.uncomparable).toBe("derivation-unavailable");
  });
});

describe("the digest is identity-only", () => {
  it("names sessions and ids, and carries no prose from the log", async () => {
    const lines = [
      "2026-08-31T12:00:01Z\tproj:api\twaiting\tWAITREASONXYZ\tnotes/CHECKPOINTXYZ.md",
      "2026-08-31T12:00:02Z\tproj:web\task\tQUESTIONXYZ\t",
      "2026-08-31T12:00:03Z\tproj:issuer\tissue\tTITLEXYZ\tBODYXYZ\t\tiss-1",
      "2026-08-31T12:00:04Z\tproj:planner\tbrief\tdirector\tBRIEFBODYXYZ\t",
      "2026-08-31T12:00:05Z\tproj:api\trequest\t7\tREQUESTTEXTXYZ",
    ];
    const digest = coordStateDigest(ingestCoordLog(lines, emptyCoordState()));

    expect(digest.length).toBeGreaterThan(0);
    for (const marker of ["WAITREASONXYZ", "CHECKPOINTXYZ", "QUESTIONXYZ", "TITLEXYZ", "BODYXYZ", "BRIEFBODYXYZ", "REQUESTTEXTXYZ"]) {
      expect(digest.join("\n")).not.toContain(marker);
    }
    expect(digest).toContain("waiting:proj:api");
    expect(digest).toContain("asking:proj:web");
    expect(digest).toContain("issue:iss-1");
    expect(digest).toContain("request:7");
  });

  it("is a sorted, deduplicated set, so an ordering difference is never a disagreement", async () => {
    const digest = coordStateDigest(ingestCoordLog([ASK_LINE], emptyCoordState()));
    expect(digest).toEqual([...new Set(digest)].sort());
  });
});
