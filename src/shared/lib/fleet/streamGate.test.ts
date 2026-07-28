import { describe, it, expect } from "vitest";
import {
  landedStreams,
  deadlockedStreams,
  partitionByDeps,
  heldReason,
  sessionDoneStreams,
  type GateStream,
  type LandedEvidence,
} from "./streamGate";

const ev = (p: Partial<LandedEvidence> = {}): LandedEvidence => ({
  doneIssues: new Set(),
  mergedBranches: new Set(),
  sessionDone: new Set(),
  ...p,
});

describe("landedStreams — the three-tier OR", () => {
  const streams: GateStream[] = [
    { id: "a", issues: ["#1", "#2"] },
    { id: "b" },
    { id: "c" },
  ];

  it("tier 1: every owned issue done ⇒ landed", () => {
    expect([...landedStreams(streams, ev({ doneIssues: new Set(["#1", "#2"]) }))]).toEqual(["a"]);
  });

  it("tier 1 is not vacuous — a stream owning NO issues is not 'all issues done'", () => {
    // The measured reality: both live fleets have 0 issues on every stream. Without this guard the
    // whole fleet would read as finished and the gate would let everything through.
    expect(landedStreams(streams, ev({ doneIssues: new Set(["#1"]) })).size).toBe(0);
  });

  it("tier 1 needs EVERY issue — a partial set is not landed", () => {
    expect(landedStreams(streams, ev({ doneIssues: new Set(["#1"]) })).has("a")).toBe(false);
  });

  it("tier 2: a merged branch lands a stream with no issues at all", () => {
    // The floor that makes a 0-issue fleet work. Nothing else can produce evidence for `b`.
    expect([...landedStreams(streams, ev({ mergedBranches: new Set(["b"]) }))]).toEqual(["b"]);
  });

  it("tier 3: a session-completion latch lands a stream", () => {
    expect([...landedStreams(streams, ev({ sessionDone: new Set(["c"]) }))]).toEqual(["c"]);
  });

  it("the tiers are OR'd, not AND'd — any ONE suffices", () => {
    // An AND would need all three signals at once, which no live project has ever had: that is the
    // permanent hang this rule exists to avoid.
    const all = landedStreams(streams, ev({
      doneIssues: new Set(["#1", "#2"]),
      mergedBranches: new Set(["b"]),
      sessionDone: new Set(["c"]),
    }));
    expect([...all].sort()).toEqual(["a", "b", "c"]);
  });

  it("no evidence ⇒ nothing landed (an empty probe is never 'all done')", () => {
    expect(landedStreams(streams, ev()).size).toBe(0);
  });
});

describe("partitionByDeps", () => {
  // The real cli-typer graph, which is where the gate earns its keep.
  const cliTyper: GateStream[] = [
    { id: "app-shell" },
    { id: "typing-engine" },
    { id: "content-library" },
    { id: "game-modes", dependsOn: ["typing-engine", "content-library"] },
    { id: "persistence-store", dependsOn: ["typing-engine"] },
    { id: "play-screen", dependsOn: ["app-shell", "typing-engine", "game-modes"] },
    { id: "results-screen", dependsOn: ["app-shell", "typing-engine", "persistence-store"] },
    { id: "main-menu", dependsOn: ["app-shell", "game-modes", "persistence-store"] },
    { id: "stats-view", dependsOn: ["app-shell", "persistence-store"] },
    { id: "settings-screen", dependsOn: ["app-shell", "persistence-store"] },
  ];

  it("gates the live cli-typer fleet down from 10 starts to 3", () => {
    // Measured on disk: app-shell, typing-engine and game-modes are merged; the other 7 are not.
    const p = partitionByDeps(cliTyper, ev({
      mergedBranches: new Set(["app-shell", "typing-engine", "game-modes"]),
    }));
    expect(p.landed.map((s) => s.id)).toEqual(["app-shell", "typing-engine", "game-modes"]);
    // play-screen IS ready: all three of its deps (app-shell, typing-engine, game-modes) are merged.
    expect(p.ready.map((s) => s.id)).toEqual(["content-library", "persistence-store", "play-screen"]);
    // The remaining four all hang off persistence-store, which has not landed.
    expect(p.held.map((h) => h.streamId)).toEqual([
      "results-screen", "main-menu", "stats-view", "settings-screen",
    ]);
  });

  it("reports only the UNLANDED deps as what a held stream waits on", () => {
    const p = partitionByDeps(cliTyper, ev({ mergedBranches: new Set(["app-shell", "typing-engine"]) }));
    const play = p.held.find((h) => h.streamId === "play-screen");
    expect(play?.waitingOn).toEqual(["game-modes"]); // app-shell + typing-engine already landed
  });

  it("a fully-landed fleet starts NOTHING — every stream goes to maintenance", () => {
    // network-monitor: all 38 branches merged. The gate is a no-op there by design; what that project
    // needs is maintenance, not 38 fresh builders.
    const p = partitionByDeps(cliTyper, ev({ mergedBranches: new Set(cliTyper.map((s) => s.id)) }));
    expect(p.landed).toHaveLength(10);
    expect(p.ready).toHaveLength(0);
    expect(p.held).toHaveLength(0);
  });

  it("a fresh fleet with no evidence starts exactly its roots", () => {
    const p = partitionByDeps(cliTyper, ev());
    expect(p.ready.map((s) => s.id)).toEqual(["app-shell", "typing-engine", "content-library"]);
    expect(p.held).toHaveLength(7);
  });

  it("readiness does NOT cascade within one pass — B waits for A to LAND, not to launch", () => {
    // The whole point of the gate. `b` must not ride along just because `a` is starting.
    const chain: GateStream[] = [{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }];
    const p = partitionByDeps(chain, ev());
    expect(p.ready.map((s) => s.id)).toEqual(["a"]);
    expect(p.held.map((h) => h.streamId)).toEqual(["b", "c"]);
  });

  it("a landed upstream releases exactly its direct dependents, one level per pass", () => {
    const chain: GateStream[] = [{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }];
    const p = partitionByDeps(chain, ev({ mergedBranches: new Set(["a"]) }));
    expect(p.ready.map((s) => s.id)).toEqual(["b"]);
    expect(p.held.map((h) => h.streamId)).toEqual(["c"]);
  });

  it("an empty fleet partitions to three empty buckets", () => {
    const p = partitionByDeps([], ev());
    expect(p).toEqual({ ready: [], landed: [], held: [] });
  });
});

describe("deadlockedStreams", () => {
  it("flags a two-node cycle", () => {
    const cyclic: GateStream[] = [{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }];
    expect([...deadlockedStreams(cyclic, new Set())].sort()).toEqual(["a", "b"]);
  });

  it("flags a stream DOWNSTREAM of a cycle — it is equally stuck", () => {
    const g: GateStream[] = [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["a"] },
    ];
    expect([...deadlockedStreams(g, new Set())].sort()).toEqual(["a", "b", "c"]);
  });

  it("a landed member BREAKS the cycle — its dep edges no longer matter", () => {
    const cyclic: GateStream[] = [{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }];
    expect(deadlockedStreams(cyclic, new Set(["b"])).size).toBe(0);
  });

  it("a plain unmet dep is NOT a deadlock", () => {
    const g: GateStream[] = [{ id: "a" }, { id: "b", dependsOn: ["a"] }];
    expect(deadlockedStreams(g, new Set()).size).toBe(0);
  });

  it("a dep naming a stream outside the fleet blocks but is not a cycle", () => {
    // A plan typo must surface as an unmet dep, not be mislabelled a dependency cycle.
    const g: GateStream[] = [{ id: "a", dependsOn: ["ghost"] }];
    expect(deadlockedStreams(g, new Set()).size).toBe(0);
    const p = partitionByDeps(g, ev());
    expect(p.held).toEqual([{ streamId: "a", waitingOn: ["ghost"], deadlocked: false }]);
  });

  it("partitionByDeps marks the cyclic streams held-and-deadlocked, never ready", () => {
    const cyclic: GateStream[] = [{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }];
    const p = partitionByDeps(cyclic, ev());
    expect(p.ready).toHaveLength(0);
    expect(p.held.every((h) => h.deadlocked)).toBe(true);
  });
});

describe("heldReason", () => {
  it("names the single upstream", () => {
    expect(heldReason({ streamId: "b", waitingOn: ["a"], deadlocked: false })).toBe("waiting on a to land");
  });

  it("counts and lists multiple upstreams", () => {
    expect(heldReason({ streamId: "c", waitingOn: ["a", "b"], deadlocked: false }))
      .toBe("waiting on 2 upstreams to land (a, b)");
  });

  it("calls a cycle a cycle so it is never mistaken for ordinary waiting", () => {
    expect(heldReason({ streamId: "a", waitingOn: ["b"], deadlocked: true }))
      .toBe("dependency cycle — cannot start (waiting on b)");
  });
});

describe("sessionDoneStreams — tier 3's producer", () => {
  it("keeps only this project's sessions and strips the key prefix", () => {
    const maintaining = [
      { session: "cli-typer:app-shell" },
      { session: "cli-typer:play-screen" },
      { session: "other-proj:app-shell" },
    ];
    expect([...sessionDoneStreams(maintaining, "cli-typer")].sort()).toEqual(["app-shell", "play-screen"]);
  });

  it("consumes only the FIRST separator, so a triage pane never poses as a stream", () => {
    // Pane ids are `<key>:<stream>` but ALSO `<key>:<repo>:triage`. Splitting greedily would yield the
    // repo name, which could collide with a real stream id and falsely satisfy its dependents.
    expect([...sessionDoneStreams([{ session: "proj:web:triage" }], "proj")]).toEqual(["web:triage"]);
  });

  it("does not match a project whose key is a PREFIX of another", () => {
    expect(sessionDoneStreams([{ session: "cli-typer-2:a" }], "cli-typer").size).toBe(0);
  });

  it("ignores a bare key with no stream part", () => {
    expect(sessionDoneStreams([{ session: "proj:" }], "proj").size).toBe(0);
  });

  it("an empty maintaining list yields nothing", () => {
    expect(sessionDoneStreams([], "proj").size).toBe(0);
  });

  it("feeds the gate — a maintaining upstream releases its dependent", () => {
    // The end-to-end shape on cli-typer: 6 workers parked in maintenance with unmerged branches, which
    // is the ONLY evidence available for them (0 issues, branch not merged).
    const g: GateStream[] = [{ id: "up" }, { id: "down", dependsOn: ["up"] }];
    const before = partitionByDeps(g, ev());
    expect(before.held.map((h) => h.streamId)).toEqual(["down"]);
    const after = partitionByDeps(g, ev({ sessionDone: sessionDoneStreams([{ session: "p:up" }], "p") }));
    expect(after.ready.map((s) => s.id)).toEqual(["down"]);
  });
});
