// The plan model lives in plan.db, and app-state.json does not carry a copy of it
// (`frontend-state-4-plan-copies-leave-app-state`).
//
// TWO HALVES, because either one alone passes while the feature is broken. The allowlist half asserts
// the sixteen keys are gone from `partialize` — but a store that simply loses its plan on restart
// would satisfy that. The hydrate half asserts plan.db actually fills them again, keyed on the exact
// `bsc` argv: a test that merely observed "it called bsc" would pass while reading the wrong verb.
//
// This is a MIGRATION, not a removal. Every store field, every setter and every writer stays; what
// changed is where the values COME FROM. So the hydrate assertions are about the fields still being
// populated — just from the store of record instead of a throwaway cache.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { loadImplementations } from "@scripts/lib/recordStore.mjs";
import { useAppStore } from "@/store";

/** The COMMITTED record, not the file — `store/persist.ts` is a record, and the committed store is
 *  what the app compiles (`the-committed-store-is-the-build-authority`). Reading a path here would be
 *  reading nothing at all. Same source `glanceNetworkTabs.test.ts` uses for this allowlist. */
const PERSIST: string = (loadImplementations() as { id: string; code: string }[])
  .find((i) => i.id === "persist.ts")!.code;

/** The sixteen keys this slice took out of the persisted snapshot — each a copy of a plan.db artifact. */
const PLAN_DB_KEYS = [
  "planStages", "planConfirmedStages", "planSkippedStages", "planStageConfig", "planClassification",
  "planFleet", "planFleetTopology", "planFleetDirectorDrive", "planDeployConfig", "planMarketConfig",
  "planTransformations", "planAutomations", "projectBlueprintId", "activeBlueprintId", "uiScreens",
  "uiApproved",
] as const;

describe("the plan model is not persisted", () => {
  it("reads a non-empty persist allowlist, so the assertions below cannot be vacuous", () => {
    // A record that failed to resolve would make every `not.toMatch` below pass against an empty
    // string — the failure mode a drift test can least afford. Two keys that MUST still be persisted
    // prove the text is the real allowlist and that the removal was surgical.
    expect(PERSIST.length).toBeGreaterThan(2000);
    // `paneCwds`, not `paneViews`: the console tab grid's keys left the allowlist with the grid
    // (`project-fleet-panes-live-only-in-glance`).
    expect(PERSIST).toMatch(/^\s*paneCwds:/m);
    // `repoPublic`, not `reposPublic`: the visibility DEFAULT is a user setting that moved to session.db
    // (`settings-and-last-navigation-live-in-user-settings`); the per-repo overrides are still persisted.
    expect(PERSIST).toMatch(/^\s*repoPublic:/m);
    expect(PERSIST).toMatch(/^\s*pinnedContext:/m);
  });

  it.each(PLAN_DB_KEYS)("keeps %s out of the persisted snapshot, because plan.db owns it", (key) => {
    // Anchored to a line-leading `<key>:` so this matches an ALLOWLIST ENTRY and not a mention of the
    // key in the omission comment that replaced it — the comment names all sixteen on purpose.
    expect(PERSIST).not.toMatch(new RegExp(`^\\s*${key}:`, "m"));
  });
});

type BscPayload = { projectKey: unknown; args: string[] };

/** What `bsc plan snapshot --json` returns for a planned project — the real shapes, taken from a live
 *  read of this repo's own plan store (`confirm` rows carry a fingerprint, `skip` is bare strings,
 *  `topology` and `director.drive` ride INSIDE the fleet blob). */
const SNAPSHOT = {
  confirm: [{ stage: "goal", fingerprint: "zx5-57ezup" }],
  skip: ["ui"],
  fleet: {
    recommended: 2,
    reasoning: "two lanes",
    topology: "peer",
    director: { enabled: true, role: "Director", drive: "heartbeat" },
    streams: [{ id: "api", name: "API", repo: "owner/repo", owns: ["src/api/**"] }],
  },
  deploy: { services: [{ name: "web", build: "npm run build" }] },
  market: { verdict: { recommendation: "go" } },
  classify: { uiMode: "custom", lifecycle: "greenfield", usesGithub: false },
  transformations: [{ id: "t1", verb: "migrate" }],
  automations: [{ name: "nightly", command: "npm test" }],
};

/** The all-absent payload — measured verbatim from `bsc plan snapshot` against a plan.db that does not
 *  exist. It exits 0, so this is what "no plan yet" and "bridge trouble" both look like from the UI. */
const EMPTY_SNAPSHOT = {
  issues: [], features: [], transformations: [], automations: [], startup: [], repos: [], mcp: [],
  confirm: [], skip: [], discovery: [], fleet: null, deploy: null, market: null, classify: null, deps: null,
};

const bscCalls = (): BscPayload[] =>
  vi.mocked(invoke).mock.calls
    .filter(([cmd]) => cmd === "bsc")
    .map(([, payload]) => payload as BscPayload);

/** Route each `bsc` argv to its stdout, the way the real bridge does (stdout is a STRING; `bscJson`
 *  parses it and `bsc plan stage get` is raw markdown, which is why it cannot go through `bscJson`). */
function routeBsc(snapshot: unknown) {
  vi.mocked(invoke).mockImplementation((cmd: string, payload?: unknown) => {
    if (cmd !== "bsc") return Promise.resolve(null as never);
    const args = (payload as BscPayload).args ?? [];
    const [a, b, c, d] = args;
    if (a === "plan" && b === "snapshot") return Promise.resolve(JSON.stringify(snapshot) as never);
    if (a === "plan" && b === "stage" && c === "list") return Promise.resolve(JSON.stringify(["goal", "Tech stack"]) as never);
    if (a === "plan" && b === "stage" && c === "get") return Promise.resolve(`# ${d}\n\nbody\n` as never);
    if (a === "project" && b === "db" && c === "get") {
      return Promise.resolve(JSON.stringify({ key: d, title: "P", blueprint: "bp-crm" }) as never);
    }
    return Promise.resolve("" as never);
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useAppStore.setState({
    planStages: {}, planConfirmedStages: {}, planSkippedStages: {}, planClassification: {},
    planFleet: {}, planFleetTopology: {}, planFleetDirectorDrive: {}, planDeployConfig: {},
    planMarketConfig: {}, planTransformations: {}, planAutomations: {}, projectBlueprintId: {},
  } as never);
});

describe("a project's plan is hydrated from plan.db", () => {
  it("fills ten artifacts from ONE snapshot read", async () => {
    routeBsc(SNAPSHOT);
    await useAppStore.getState().hydratePlanFromDb("proj");
    const s = useAppStore.getState();

    expect(s.planConfirmedStages["proj"]).toEqual(["goal"]);   // the fingerprint is not store state
    expect(s.planSkippedStages["proj"]).toEqual(["ui"]);
    expect(s.planFleet["proj"]?.streams.map((x) => x.id)).toEqual(["api"]);
    expect(s.planFleet["proj"]?.recommended).toBe(2);
    // Both overrides come from INSIDE the fleet blob, so they cannot disagree with the fleet.
    expect(s.planFleetTopology["proj"]).toBe("peer");
    expect(s.planFleetDirectorDrive["proj"]).toBe("heartbeat");
    expect(s.planDeployConfig["proj"]).toEqual(SNAPSHOT.deploy);
    expect(s.planMarketConfig["proj"]).toEqual(SNAPSHOT.market);
    expect(s.planClassification["proj"]).toEqual(SNAPSHOT.classify);
    expect(s.planTransformations["proj"]).toEqual(SNAPSHOT.transformations);
    expect(s.planAutomations["proj"]).toEqual(SNAPSHOT.automations);

    // ONE snapshot spawn, not one per artifact — the whole reason `bsc plan snapshot` exists (#3842).
    const snapshots = bscCalls().filter((c) => c.args[1] === "snapshot");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ projectKey: "proj", args: ["plan", "snapshot", "--json"] });
  });

  it("reads the stage prose with the verb beside it, canonicalizing each doc name", async () => {
    routeBsc(SNAPSHOT);
    await useAppStore.getState().hydratePlanFromDb("proj");
    const stages = useAppStore.getState().planStages["proj"]!;
    // "Tech stack" must land on `stack`: a stale title-named section is what leaves a gate stuck
    // (the bug `canonicalizePlanStages` exists for), so it is canonicalized at the SOURCE here.
    expect(Object.keys(stages).sort()).toEqual(["goal", "stack"]);
    expect(stages["stack"]).toContain("# Tech stack");
    // Raw markdown, so it must NOT go through the JSON reader.
    expect(bscCalls().some((c) => c.args.join(" ") === "plan stage get goal")).toBe(true);
  });

  it("takes the seeding blueprint from the projects.db row, not from bsc plan blueprint", async () => {
    routeBsc(SNAPSHOT);
    await useAppStore.getState().hydratePlanFromDb("proj");
    expect(useAppStore.getState().projectBlueprintId["proj"]).toBe("bp-crm");
    // `bsc plan blueprint` is a DIFFERENT fact — the blueprint an authoring project is designing —
    // so reading it here would bind the wrong value. It must never be consulted for this.
    expect(bscCalls().some((c) => c.args[0] === "plan" && c.args[1] === "blueprint")).toBe(false);
    expect(bscCalls().some((c) => c.args.join(" ") === "project db get proj")).toBe(true);
  });

  it("leaves a loaded plan alone when plan.db has nothing to say, rather than blanking it", async () => {
    // The regression this guards: an unreachable bridge, a project with no plan.db and a genuinely
    // empty plan are indistinguishable from the UI, and all three arrive as this payload. Replacing a
    // real plan with an empty one is strictly worse than showing the last known one.
    const loaded = { recommended: 1, reasoning: "keep me", streams: [], director: { enabled: false } };
    useAppStore.setState({
      planFleet: { proj: loaded }, planClassification: { proj: { uiMode: "custom" } },
    } as never);
    routeBsc(EMPTY_SNAPSHOT);
    await useAppStore.getState().hydratePlanFromDb("proj");
    const s = useAppStore.getState();
    expect(s.planFleet["proj"]).toEqual(loaded);
    expect(s.planClassification["proj"]).toEqual({ uiMode: "custom" });
  });

  it("hydrates only the project asked for, leaving every other project's plan untouched", async () => {
    const other = { recommended: 9, reasoning: "other", streams: [], director: { enabled: false } };
    useAppStore.setState({ planFleet: { other } } as never);
    routeBsc(SNAPSHOT);
    await useAppStore.getState().hydratePlanFromDb("proj");
    expect(useAppStore.getState().planFleet["other"]).toEqual(other);
    expect(useAppStore.getState().planFleet["proj"]).toBeTruthy();
  });

  it("spawns nothing for an empty project key", async () => {
    routeBsc(SNAPSHOT);
    await useAppStore.getState().hydratePlanFromDb("   ");
    expect(bscCalls()).toHaveLength(0);
  });
});
