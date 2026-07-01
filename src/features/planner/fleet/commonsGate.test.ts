import { describe, it, expect } from "vitest";
import {
  COMMONS_STREAM_ID,
  excludeCommonsFromStreams,
  gateStreamsOnCommons,
  applyCommonsGate,
} from "./commonsGate";
import { commonsGlobsForStack } from "@/shared/lib/session/commons";
import type { AgentStream, FleetPlan } from "./planFleet";

const stream = (over: Partial<AgentStream> = {}): AgentStream => ({
  id: "auth-ui",
  name: "Auth UI",
  repo: "own/web",
  owns: ["src/auth/**"],
  issues: ["#12"],
  dependsOn: [],
  ...over,
});

const fleet = (over: Partial<FleetPlan> = {}): FleetPlan => ({
  recommended: 2,
  reasoning: "",
  streams: [stream()],
  director: { enabled: true },
  ...over,
});

const COMMONS = commonsGlobsForStack(["tauri"]); // js/ts + rust commons

describe("excludeCommonsFromStreams (#851 — no feature stream owns a commons path)", () => {
  it("strips a commons path a stream declared in owns", () => {
    const streams = [
      stream({ id: "a", owns: ["src/a/**", ".gitignore", "package.json"] }),
      stream({ id: "b", owns: [".github/workflows/ci.yml", "src/b/**"] }),
    ];
    const out = excludeCommonsFromStreams(streams, COMMONS);
    expect(out[0].owns).toEqual(["src/a/**"]);
    expect(out[1].owns).toEqual(["src/b/**"]);
  });

  it("NO stream owns any commons path after exclusion", () => {
    const streams = [
      stream({ id: "a", owns: ["src/a/**", "tsconfig.json"] }),
      stream({ id: "b", owns: ["Cargo.toml", "src/b/**", ".env.example"] }),
    ];
    const out = excludeCommonsFromStreams(streams, COMMONS);
    for (const s of out) {
      for (const owned of s.owns) {
        expect(COMMONS).not.toContain(owned);
      }
    }
  });

  it("leaves a pure feature stream untouched (same reference)", () => {
    const s = stream({ owns: ["src/auth/**"] });
    const out = excludeCommonsFromStreams([s], COMMONS);
    expect(out[0]).toBe(s); // unchanged → original object reused
  });
});

describe("gateStreamsOnCommons (#851 — Phase 0)", () => {
  it("adds the commons-landed sentinel to every feature stream's dependsOn", () => {
    const out = gateStreamsOnCommons([stream({ dependsOn: ["api"] }), stream({ id: "b", dependsOn: [] })], COMMONS, true);
    expect(out[0].dependsOn).toContain(COMMONS_STREAM_ID);
    expect(out[0].dependsOn).toContain("api"); // existing deps preserved
    expect(out[1].dependsOn).toEqual([COMMONS_STREAM_ID]);
  });

  it("is a no-op when there is no director (no commons steward)", () => {
    const streams = [stream({ dependsOn: [] })];
    expect(gateStreamsOnCommons(streams, COMMONS, false)).toBe(streams);
  });

  it("is a no-op when there are no commons", () => {
    const streams = [stream({ dependsOn: [] })];
    expect(gateStreamsOnCommons(streams, [], true)).toBe(streams);
  });

  it("does not double-add the sentinel (idempotent)", () => {
    const once = gateStreamsOnCommons([stream({ dependsOn: [] })], COMMONS, true);
    const twice = gateStreamsOnCommons(once, COMMONS, true);
    expect(twice[0].dependsOn.filter((d) => d === COMMONS_STREAM_ID)).toHaveLength(1);
  });
});

describe("applyCommonsGate (both transforms together)", () => {
  it("excludes commons from owns AND gates feature streams on commons-landed", () => {
    const plan = fleet({
      streams: [stream({ id: "a", owns: ["src/a/**", "package.json"], dependsOn: [] })],
    });
    const out = applyCommonsGate(plan, COMMONS);
    expect(out.streams[0].owns).toEqual(["src/a/**"]);
    expect(out.streams[0].dependsOn).toContain(COMMONS_STREAM_ID);
    // director + other fields pass through
    expect(out.director).toEqual(plan.director);
    expect(out.recommended).toBe(plan.recommended);
  });

  it("does not gate when the fleet has no director (owns-exclusion still applies)", () => {
    const plan = fleet({
      director: { enabled: false },
      streams: [stream({ id: "a", owns: ["src/a/**", ".gitignore"], dependsOn: [] })],
    });
    const out = applyCommonsGate(plan, COMMONS);
    expect(out.streams[0].owns).toEqual(["src/a/**"]);
    expect(out.streams[0].dependsOn).not.toContain(COMMONS_STREAM_ID);
  });
});
