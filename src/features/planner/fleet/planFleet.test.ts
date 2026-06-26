import { describe, it, expect } from "vitest";
import { parseFleetFile } from "./planFleet";

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

  it("drops streams missing id or repo", () => {
    const raw = JSON.stringify({ streams: [{ name: "no id", repo: "own/web" }, { id: "no-repo" }, { id: "ok", repo: "own/api" }] });
    expect(parseFleetFile(raw)?.streams.map(s => s.id)).toEqual(["ok"]);
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

  it("returns null for blank or malformed input", () => {
    expect(parseFleetFile("")).toBeNull();
    expect(parseFleetFile("   ")).toBeNull();
    expect(parseFleetFile("{not json")).toBeNull();
    expect(parseFleetFile("[1,2,3]")).toBeNull();
  });
});
