// The `bsc fleet start` bridge — what a CLI launch request does to the store.
//
// The rules worth pinning are all about NOT LOSING THE PLAN: a stream carries far more than an id,
// and the whole point of routing through `fleetStartProject` is that a CLI launch and a UI launch
// produce the same fleet. A bridge that quietly synthesized thinner streams would look correct and
// launch workers with no scope.

import { describe, it, expect, vi } from "vitest";
import { applyFleetStart, startPlan, worktreePaths, type StartRequest } from "@/app/fleetStartBridge";

const req = (over: Partial<StartRequest> = {}): StartRequest => ({
  id: "req-1",
  projectKey: "my-app",
  director: true,
  hubPath: "/hub/my-app",
  streams: [],
  ...over,
});

// A realistic plan row — the shape `bsc plan fleet get --full` returns.
const stream = (over: Record<string, unknown> = {}) =>
  ({
    id: "api",
    name: "API layer",
    repo: "o/r",
    owns: ["src/api/**"],
    issues: ["#12", "#13"],
    dependsOn: ["schema"],
    flow: { autonomy: "checkpoint", push: "auto-pr" },
    profile: "prof-1",
    persona: "persona-worker",
    model: "claude-sonnet-4-6",
    prompt: "prompts/api-kickoff.md",
    worktree: "/wt/o-r--api",
    ...over,
  }) as never;

describe("startPlan", () => {
  it("passes the plan's stream fields through instead of rebuilding thinner ones", () => {
    // THE REGRESSION THIS GUARDS: an earlier draft built `{id, repo, owns: [], issues: [], dependsOn: []}`
    // and every worker would have launched with no scope, no issues and no flow — a fleet that looks
    // right on the tab strip and does nothing right.
    const plan = startPlan(req({ streams: [stream()] }));
    const s = plan.streams[0];
    expect(s.owns).toEqual(["src/api/**"]);
    expect(s.issues).toEqual(["#12", "#13"]);
    expect(s.dependsOn).toEqual(["schema"]);
    expect(s.flow).toEqual({ autonomy: "checkpoint", push: "auto-pr" });
    expect(s.profile).toBe("prof-1");
    expect(s.persona).toBe("persona-worker");
    expect(s.model).toBe("claude-sonnet-4-6");
    expect(s.prompt).toBe("prompts/api-kickoff.md");
    expect(s.name).toBe("API layer");
  });

  it("strips the launch-time worktree from the stream, since it travels as a path", () => {
    // `fleetStartProject` reads worktrees from `paths.worktreePaths`, not off the stream. Leaving it
    // on the stream would put a second copy of the same fact into the stored plan shape.
    const plan = startPlan(req({ streams: [stream()] }));
    expect(plan.streams[0]).not.toHaveProperty("worktree");
  });

  it("defaults the arrays a hand-written plan row may omit", () => {
    // `fleetStartProject` indexes into owns/issues/dependsOn; a plan row written by hand (or by an
    // older planner) can legitimately lack them, and an undefined there is a crash, not a launch.
    const plan = startPlan(req({ streams: [{ id: "bare", repo: "o/r" } as never] }));
    const s = plan.streams[0];
    expect(s.owns).toEqual([]);
    expect(s.issues).toEqual([]);
    expect(s.dependsOn).toEqual([]);
    // A nameless stream still gets a name — the tab and roster show it.
    expect(s.name).toBe("bare");
  });

  it("reports the real worker count and the director flag it was given", () => {
    const plan = startPlan(req({ streams: [stream(), stream({ id: "ui" })], director: false }));
    expect(plan.recommended).toBe(2);
    expect(plan.director.enabled).toBe(false);
    // The reasoning names where the launch came from, so a later reader knows why this tab exists.
    expect(plan.reasoning).toContain("bsc fleet start");
  });
});

describe("worktreePaths", () => {
  it("maps each stream id to the absolute worktree Rust already created", () => {
    // These are the paths that become each pane's cwd (#905). Re-deriving them in the frontend is
    // what the async-loaded bscBaseDir mirror got wrong, dropping sessions at the user's home dir.
    expect(worktreePaths(req({ streams: [stream(), stream({ id: "ui", worktree: "/wt/o-r--ui" })] })))
      .toEqual({ api: "/wt/o-r--api", ui: "/wt/o-r--ui" });
  });

  it("omits a stream with no worktree rather than mapping it to empty", () => {
    // An empty cwd is the home-dir bug again; absent means fleetStartProject falls back deliberately.
    expect(worktreePaths(req({ streams: [stream({ worktree: "" })] }))).toEqual({});
  });
});

describe("applyFleetStart", () => {
  it("launches through fleetStartProject and acks", () => {
    const fleetStartProject = vi.fn();
    const ack = applyFleetStart(req({ streams: [stream()] }), { fleetStartProject });
    expect(ack).toEqual({ id: "req-1", launched: true });
    const [name, plan, key, paths] = fleetStartProject.mock.calls[0];
    expect(name).toBe("my-app");
    expect(key).toBe("my-app");
    expect(plan.streams).toHaveLength(1);
    expect(paths).toEqual({ hubPath: "/hub/my-app", worktreePaths: { api: "/wt/o-r--api" } });
  });

  it("NEVER throws — a throw in the launch becomes an error ack", () => {
    // Silence would strand the Rust waiter until its 30s timeout and surface as "the frontend did not
    // launch the fleet", sending someone to debug the wrong side entirely.
    const fleetStartProject = vi.fn(() => {
      throw new Error("tab limit");
    });
    const ack = applyFleetStart(req({ streams: [stream()] }), { fleetStartProject });
    expect(ack.launched).toBe(false);
    expect(ack.error).toContain("tab limit");
    expect(ack.id).toBe("req-1");
  });

  it("refuses a request with no project key", () => {
    const fleetStartProject = vi.fn();
    const ack = applyFleetStart(req({ projectKey: "  ", streams: [stream()] }), { fleetStartProject });
    expect(ack.launched).toBe(false);
    expect(fleetStartProject).not.toHaveBeenCalled();
  });

  it("refuses a launch with neither a director nor any stream", () => {
    // Rust refuses this before emitting, so arriving here means the two sides disagree — an error
    // beats opening an empty build tab that looks like a fleet.
    const fleetStartProject = vi.fn();
    const ack = applyFleetStart(req({ director: false, streams: [] }), { fleetStartProject });
    expect(ack.launched).toBe(false);
    expect(ack.error).toContain("nothing to launch");
    expect(fleetStartProject).not.toHaveBeenCalled();
  });

  it("launches a director-only fleet, which is what a start on a stream-less plan means", () => {
    const fleetStartProject = vi.fn();
    const ack = applyFleetStart(req({ director: true, streams: [] }), { fleetStartProject });
    expect(ack.launched).toBe(true);
    expect(fleetStartProject.mock.calls[0][1].director.enabled).toBe(true);
  });
});
