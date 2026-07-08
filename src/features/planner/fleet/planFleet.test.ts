import { describe, it, expect } from "vitest";
import { parseFleetFile } from "./planFleet";
import { DEFAULT_FLOW } from "./agentFlow";

describe("parseFleetFile", () => {
  it("parses a full fleet, defaulting list fields", () => {
    const raw = JSON.stringify({
      recommended: 3,
      reasoning: "three independent areas",
      director: { enabled: true, role: "integrator" },
      streams: [
        { id: "auth-ui", name: "Auth UI", repo: "own/web", owns: ["src/auth/**"], issues: ["#1", "#2"], dependsOn: [], prompt: "prompts/auth-ui-kickoff.md" },
        { id: "api", repo: "own/api" },
      ],
    });
    expect(parseFleetFile(raw)).toEqual({
      recommended: 3,
      reasoning: "three independent areas",
      director: { enabled: true, role: "integrator", drive: "event" },
      streams: [
        { id: "auth-ui", name: "Auth UI", repo: "own/web", owns: ["src/auth/**"], issues: ["#1", "#2"], dependsOn: [], prompt: "prompts/auth-ui-kickoff.md" },
        { id: "api", name: "api", repo: "own/api", owns: [], issues: [], dependsOn: [], prompt: undefined },
      ],
      // Agent-relationship fields default to empty when the fleet declares none (#…).
      artifacts: [],
      edges: [],
    });
  });

  it("drops a stream with no id, but KEEPS a repo-less stream visible (#2611 — no silent hiding)", () => {
    const raw = JSON.stringify({ streams: [{ name: "no id", repo: "own/web" }, { id: "no-repo" }, { id: "ok", repo: "own/api" }] });
    // the id-less stream is dropped (unkeyable); the repo-less one STAYS (repo "") so it shows in the plan
    const streams = parseFleetFile(raw)!.streams;
    expect(streams.map(s => s.id)).toEqual(["no-repo", "ok"]);
    expect(streams.find(s => s.id === "no-repo")!.repo).toBe("");
  });

  it("defaults a repo-less stream to the project's SOLE repo (#2611)", () => {
    const raw = JSON.stringify({ streams: [{ id: "a" }, { id: "b", repo: "own/api" }] });
    const streams = parseFleetFile(raw, ["own/web"])!.streams;
    expect(streams.find(s => s.id === "a")!.repo).toBe("own/web"); // defaulted to the one linked repo
    expect(streams.find(s => s.id === "b")!.repo).toBe("own/api"); // an explicit repo is untouched
  });

  it("keeps a repo-less stream empty (visible) when the repo can't be defaulted (0 or >1 repos)", () => {
    const raw = JSON.stringify({ streams: [{ id: "a" }] });
    expect(parseFleetFile(raw, [])!.streams[0].repo).toBe("");                     // no repos → can't default
    expect(parseFleetFile(raw, ["own/web", "own/api"])!.streams[0].repo).toBe(""); // ambiguous → don't guess
  });

  it("carries a stream's assigned MCP servers, undefined when none (#1054)", () => {
    const raw = JSON.stringify({
      streams: [
        { id: "sci", repo: "o/r", mcp: ["Research", "Compliance"] },
        { id: "ui", repo: "o/r" },
      ],
    });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.streams[0].mcp).toEqual(["Research", "Compliance"]);
    expect(fleet.streams[1].mcp).toBeUndefined();
  });

  it("carries a stream's granted commands, undefined when none (#1572)", () => {
    const raw = JSON.stringify({
      streams: [
        { id: "rust", repo: "o/r", commands: ["cargo", "wasm-pack"] },
        { id: "ui", repo: "o/r" },
      ],
    });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.streams[0].commands).toEqual(["cargo", "wasm-pack"]);
    expect(fleet.streams[1].commands).toBeUndefined();
  });

  it("carries a stream's persona reference, undefined when none (#2094)", () => {
    const raw = JSON.stringify({
      streams: [
        { id: "docs", repo: "o/r", persona: "persona-documentor" },
        { id: "ui", repo: "o/r" },
        { id: "blank", repo: "o/r", persona: "  " }, // whitespace ⇒ undefined
      ],
    });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.streams[0].persona).toBe("persona-documentor");
    expect(fleet.streams[1].persona).toBeUndefined();
    expect(fleet.streams[2].persona).toBeUndefined();
  });

  it("round-trips a per-stream model (the `claude --model` tier), validating it", () => {
    const raw = JSON.stringify({
      streams: [
        { id: "deep",  repo: "o/r", model: "opus-4.5" },   // valid tier — kept
        { id: "cheap", repo: "o/r", model: "gpt-4o"   },   // not a known tier — dropped
        { id: "plain", repo: "o/r" },                       // unset — undefined
      ],
    });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.streams[0].model).toBe("opus-4.5");
    expect(fleet.streams[1].model).toBeUndefined();
    expect(fleet.streams[2].model).toBeUndefined();
  });

  it("accepts depends_on as an alias and coerces a string recommended", () => {
    const raw = JSON.stringify({
      recommended: "2",
      director: { enabled: "true" },
      streams: [{ id: "b", repo: "o/r", depends_on: ["a"] }],
    });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.recommended).toBe(2);
    expect(fleet.director.enabled).toBe(true);
    expect(fleet.streams[0].dependsOn).toEqual(["a"]);
  });

  it("round-trips fleet + stream integration strategy (#378)", () => {
    const raw = JSON.stringify({
      recommended: 2,
      strategy: "pr-ci",
      streams: [
        { id: "a", repo: "o/r", strategy: "manual" },
        { id: "b", repo: "o/r" },
      ],
    });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.strategy).toBe("pr-ci");
    expect(fleet.streams[0].strategy).toBe("manual");
    expect(fleet.streams[1].strategy).toBeUndefined();
  });

  it("drops an invalid fleet/stream strategy to undefined (#378)", () => {
    const raw = JSON.stringify({ strategy: "bogus", streams: [{ id: "a", repo: "o/r", strategy: "nope" }] });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.strategy).toBeUndefined();
    expect(fleet.streams[0].strategy).toBeUndefined();
  });

  it("reads a stream's NESTED flow object (#297, canonical shape)", () => {
    const raw = JSON.stringify({
      streams: [
        { id: "a", repo: "o/r", flow: { autonomy: "checkpoint", push: "push-confirm", trigger: "per-stage", gate: "soft" } },
      ],
    });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.streams[0].flow).toEqual({
      autonomy: "checkpoint", push: "push-confirm", trigger: "per-stage", gate: "soft",
    });
  });

  it("normalizes FLAT autonomy/push/trigger/gate to the same nested flow (#1804)", () => {
    const raw = JSON.stringify({
      streams: [
        { id: "a", repo: "o/r", autonomy: "checkpoint", push: "push-confirm", trigger: "per-stage", gate: "soft" },
      ],
    });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.streams[0].flow).toEqual({
      autonomy: "checkpoint", push: "push-confirm", trigger: "per-stage", gate: "soft",
    });
  });

  it("prefers a named nested flow over flat fields (#1804)", () => {
    const raw = JSON.stringify({
      streams: [
        { id: "a", repo: "o/r", autonomy: "continuous", flow: { autonomy: "confirm", push: "none" } },
      ],
    });
    const fleet = parseFleetFile(raw)!;
    // nested wins entirely; its unset fields fall back to DEFAULT_FLOW, NOT to the flat top-level values.
    expect(fleet.streams[0].flow).toEqual({
      autonomy: "confirm", push: "none", trigger: DEFAULT_FLOW.trigger, gate: DEFAULT_FLOW.gate,
    });
  });

  it("leaves flow undefined when a stream specifies neither nested nor flat flow (#1804 → DEFAULT_FLOW at launch)", () => {
    const raw = JSON.stringify({ streams: [{ id: "a", repo: "o/r" }] });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.streams[0].flow).toBeUndefined();
  });

  it("returns null for blank or malformed input", () => {
    expect(parseFleetFile("")).toBeNull();
    expect(parseFleetFile("   ")).toBeNull();
    expect(parseFleetFile("{not json")).toBeNull();
    expect(parseFleetFile("[1,2,3]")).toBeNull();
  });
});
