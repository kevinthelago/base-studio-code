import { describe, it, expect } from "vitest";
import {
  COMMONS_STREAM_ID,
  INTEGRATION_STREAM_ID,
  laneIdFor,
  isLaneStream,
  commonsLanesFor,
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
  it("adds the commons lane to every feature stream's dependsOn", () => {
    const out = gateStreamsOnCommons([stream({ dependsOn: ["api"] }), stream({ id: "b", dependsOn: [] })], COMMONS);
    expect(out[0].dependsOn).toContain(COMMONS_STREAM_ID);
    expect(out[0].dependsOn).toContain("api"); // existing deps preserved
    expect(out[1].dependsOn).toEqual([COMMONS_STREAM_ID]);
  });

  it("still gates a DIRECTOR-LESS fleet (#funnel-commons-and-integration-streams)", () => {
    // It used to be a no-op without a director, because the DIRECTOR was the commons steward and a
    // director-less fleet therefore had none. The owner is a worker now, so the gate always holds —
    // this is the assertion the old `no director ⇒ no-op` test becomes.
    const out = gateStreamsOnCommons([stream({ dependsOn: [] })], COMMONS);
    expect(out[0].dependsOn).toEqual([COMMONS_STREAM_ID]);
  });

  it("is a no-op when there are no commons", () => {
    const streams = [stream({ dependsOn: [] })];
    expect(gateStreamsOnCommons(streams, [])).toBe(streams);
  });

  it("does not double-add the lane (idempotent)", () => {
    const once = gateStreamsOnCommons([stream({ dependsOn: [] })], COMMONS);
    const twice = gateStreamsOnCommons(once, COMMONS);
    expect(twice[0].dependsOn.filter((d) => d === COMMONS_STREAM_ID)).toHaveLength(1);
  });

  it("gates each stream on ITS OWN repo's commons lane when the fleet spans repos", () => {
    const out = gateStreamsOnCommons(
      [stream({ id: "a", repo: "own/web" }), stream({ id: "b", repo: "own/api" })],
      COMMONS,
    );
    expect(out[0].dependsOn).toEqual([laneIdFor(COMMONS_STREAM_ID, "own/web", true)]);
    expect(out[1].dependsOn).toEqual([laneIdFor(COMMONS_STREAM_ID, "own/api", true)]);
    // …and the two are genuinely distinct: one repo's commons landing says nothing about the other's.
    expect(out[0].dependsOn).not.toEqual(out[1].dependsOn);
  });
});

describe("laneIdFor / isLaneStream", () => {
  it("keeps the bare ids for the single-repo case, so branch + pane names are unchanged", () => {
    expect(laneIdFor(COMMONS_STREAM_ID, "own/web", false)).toBe("commons");
    expect(laneIdFor(INTEGRATION_STREAM_ID, "own/web", false)).toBe("integration");
  });

  it("suffixes a slug of the repo when the fleet spans repos", () => {
    expect(laneIdFor(COMMONS_STREAM_ID, "own/web", true)).toBe("commons--own-web");
    expect(laneIdFor(INTEGRATION_STREAM_ID, "Own/API", true)).toBe("integration--own-api");
  });

  it("produces ids that are safe as a branch name (no slashes, dots or spaces)", () => {
    // The stream id IS the branch name and part of the pane id, so a raw `own/web` would cut a
    // branch inside a ref directory and collide with the repo's own refs.
    for (const repo of ["own/web", "Own/API", "a.b/c d"]) {
      expect(laneIdFor(COMMONS_STREAM_ID, repo, true)).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("recognizes both the bare and the per-repo lane ids", () => {
    expect(isLaneStream("commons")).toBe(true);
    expect(isLaneStream("integration")).toBe(true);
    expect(isLaneStream("commons--own-web")).toBe(true);
    expect(isLaneStream("integration--own-api")).toBe(true);
    expect(isLaneStream("auth-ui")).toBe(false);
    expect(isLaneStream("commonsense")).toBe(false); // prefix, but not a lane
  });
});

describe("commonsLanesFor (the lanes are REAL streams now)", () => {
  it("emits a commons lane that OWNS the commons and depends on nothing", () => {
    const [commons] = commonsLanesFor([stream()], COMMONS);
    expect(commons.id).toBe(COMMONS_STREAM_ID);
    expect(commons.repo).toBe("own/web");
    expect(commons.owns).toEqual(COMMONS);
    expect(commons.dependsOn).toEqual([]); // first wave — everything else gates on it
  });

  it("emits an integration lane that owns NO source and waits for the commons", () => {
    const [, integration] = commonsLanesFor([stream()], COMMONS);
    expect(integration.id).toBe(INTEGRATION_STREAM_ID);
    // Its artifacts are merges, a revert and seam-test runs. Globs would make it a second writer on
    // someone else's lane — the exact collision #851 exists to prevent.
    expect(integration.owns).toEqual([]);
    expect(integration.dependsOn).toEqual([COMMONS_STREAM_ID]);
  });

  it("emits one PAIR PER REPO, because commons are a property of a repo root", () => {
    const lanes = commonsLanesFor([stream({ repo: "own/web" }), stream({ id: "b", repo: "own/api" })], COMMONS);
    expect(lanes.map((l) => l.id)).toEqual([
      "commons--own-web", "integration--own-web",
      "commons--own-api", "integration--own-api",
    ]);
    // Each integration lane waits on ITS OWN repo's commons, not on the other repo's.
    expect(lanes[1].dependsOn).toEqual(["commons--own-web"]);
    expect(lanes[3].dependsOn).toEqual(["commons--own-api"]);
  });

  it("emits nothing when there are no commons, and nothing when there is no repo to own them in", () => {
    expect(commonsLanesFor([stream()], [])).toEqual([]);
    expect(commonsLanesFor([], COMMONS)).toEqual([]);
  });
});

describe("applyCommonsGate (all three transforms together)", () => {
  it("excludes commons from owns, gates feature streams, AND materializes the lanes", () => {
    const plan = fleet({
      streams: [stream({ id: "a", owns: ["src/a/**", "package.json"], dependsOn: [] })],
    });
    const out = applyCommonsGate(plan, COMMONS);

    // The lanes lead the launch order (Phase 0 is what "first" means here).
    expect(out.streams.map((s) => s.id)).toEqual([COMMONS_STREAM_ID, INTEGRATION_STREAM_ID, "a"]);
    const feature = out.streams.find((s) => s.id === "a")!;
    expect(feature.owns).toEqual(["src/a/**"]);
    expect(feature.dependsOn).toContain(COMMONS_STREAM_ID);
    // director + other fields pass through
    expect(out.director).toEqual(plan.director);
    expect(out.recommended).toBe(plan.recommended);
  });

  it("leaves the commons lane's OWN globs intact — the exclusion must not disown the owner", () => {
    // Order is load-bearing: exclusion runs on the feature streams alone. Run it over a list that
    // already contains the commons lane and it strips exactly the globs that make it the owner,
    // leaving the commons owned by nobody. This is the regression that guards that ordering.
    const out = applyCommonsGate(fleet({ streams: [stream({ id: "a", owns: ["src/a/**"] })] }), COMMONS);
    const commons = out.streams.find((s) => s.id === COMMONS_STREAM_ID)!;
    expect(commons.owns).toEqual(COMMONS);
    expect(commons.owns.length).toBeGreaterThan(0);
  });

  it("every commons path has exactly ONE owner across the whole fleet", () => {
    const out = applyCommonsGate(
      fleet({ streams: [stream({ id: "a", owns: ["src/a/**", ".gitignore"] }), stream({ id: "b", owns: ["package.json"] })] }),
      COMMONS,
    );
    for (const glob of COMMONS) {
      const owners = out.streams.filter((s) => s.owns.includes(glob)).map((s) => s.id);
      expect(owners).toEqual([COMMONS_STREAM_ID]);
    }
  });

  it("gives a DIRECTOR-LESS fleet the lanes too (the owner is a worker, not the director)", () => {
    const out = applyCommonsGate(
      fleet({ director: { enabled: false }, streams: [stream({ id: "a", owns: ["src/a/**", ".gitignore"] })] }),
      COMMONS,
    );
    expect(out.streams.map((s) => s.id)).toContain(COMMONS_STREAM_ID);
    expect(out.streams.find((s) => s.id === "a")!.owns).toEqual(["src/a/**"]);
    expect(out.streams.find((s) => s.id === "a")!.dependsOn).toContain(COMMONS_STREAM_ID);
  });

  it("no lane depends on itself (a self-gate would never release)", () => {
    const out = applyCommonsGate(fleet({ streams: [stream({ id: "a" })] }), COMMONS);
    for (const s of out.streams) expect(s.dependsOn).not.toContain(s.id);
  });
});
