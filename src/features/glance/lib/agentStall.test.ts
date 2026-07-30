import { describe, it, expect } from "vitest";
import { ACTIVITY_META } from "./glanceGraph";
import { applyStallHealth, applyFleetLiveStatus, liveWaits, projectKeyOfSession, STALL_WARN_MS, type WaitLite, type FleetLiveSignals } from "./agentStall";
import type { ProjectLite } from "./glanceData";
import type { GRawNode } from "./glanceGraph";
import { fleetPaneId } from "@/app/console/lib/paneIdentity";

const T0 = 1_720_000_000_000; // a fixed "now" base
const projects: ProjectLite[] = [
  { id: "alpha", name: "Alpha", health: "healthy", activity: "building" },
  { id: "beta", name: "Beta", health: "off", activity: "building" },
];

describe("projectKeyOfSession", () => {
  it("takes the plan key prefix before the first ':' (worker / director / triage pane ids)", () => {
    expect(projectKeyOfSession("alpha:auth")).toBe("alpha");
    expect(projectKeyOfSession("alpha:director")).toBe("alpha");
    expect(projectKeyOfSession("alpha:own/web:triage")).toBe("alpha");
    expect(projectKeyOfSession("bare")).toBe("bare"); // no colon → whole id
  });
});

describe("applyStallHealth (#2541 watchdog)", () => {
  it("a FRESH wait is calm — activity 'waiting', health untouched", () => {
    const waiting: WaitLite[] = [{ session: "alpha:auth", reason: "awaiting review", at: T0 - 60_000 }]; // 1m
    const out = applyStallHealth(projects, waiting, T0);
    expect(out.find((p) => p.id === "alpha")).toMatchObject({ activity: "waiting", health: "healthy" });
    expect(out.find((p) => p.id === "beta")).toEqual(projects[1]); // no wait → untouched
  });

  it("an OVERSTAYED wait escalates to a 'warning' with a duration reason", () => {
    const waiting: WaitLite[] = [{ session: "beta:worker", reason: "no instructions", at: T0 - 12 * 60_000 }]; // 12m
    const out = applyStallHealth(projects, waiting, T0);
    expect(out.find((p) => p.id === "beta")).toMatchObject({ activity: "waiting", health: "warning", reason: "no instructions · 12m" });
  });

  it("falls back to a default note when the wait reason is empty", () => {
    const waiting: WaitLite[] = [{ session: "beta:worker", reason: "  ", at: T0 - STALL_WARN_MS - 1 }];
    const out = applyStallHealth(projects, waiting, T0);
    expect(out.find((p) => p.id === "beta")?.reason).toMatch(/^no instructions · \d+m$/);
  });

  it("uses the OLDEST outstanding wait per project (longest stall wins)", () => {
    const waiting: WaitLite[] = [
      { session: "beta:w1", reason: "recent", at: T0 - 2 * 60_000 },
      { session: "beta:w2", reason: "stuck", at: T0 - 30 * 60_000 }, // oldest → decides
    ];
    const out = applyStallHealth(projects, waiting, T0);
    expect(out.find((p) => p.id === "beta")).toMatchObject({ health: "warning", reason: "stuck · 30m" });
  });

  it("never DOWNGRADES an already-error project (error beats a stall)", () => {
    const errored: ProjectLite[] = [{ id: "beta", name: "Beta", health: "error", activity: "building", reason: "boom" }];
    const waiting: WaitLite[] = [{ session: "beta:w", reason: "waiting", at: T0 - 20 * 60_000 }];
    const out = applyStallHealth(errored, waiting, T0);
    expect(out[0].health).toBe("error"); // kept; only escalates, never downgrades
  });

  it("no waiting sessions → the input is returned untouched", () => {
    expect(applyStallHealth(projects, [], T0)).toBe(projects);
  });
});

// #3429 — the watchdog escalated on ANY outstanding wait, and nothing ever clears a wait whose session
// died (CoordState.waiting is a coord-log replay; only a later event from the SAME session removes an
// entry, and killing a pane emits none). So `now - w.at` grew forever and the project stayed orange.
describe("liveWaits — a dead session's wait is not a stall (#3429)", () => {
  const waiting: WaitLite[] = [
    { session: "alpha:auth", reason: "needs a decision", at: T0 },
    { session: "beta:store", reason: "parked", at: T0 },
  ];

  it("drops a wait whose pane is no longer live", () => {
    expect(liveWaits(waiting, new Set(["alpha:auth"]))).toEqual([waiting[0]]);
  });

  it("drops every wait when nothing is launched", () => {
    expect(liveWaits(waiting, new Set())).toEqual([]);
  });

  it("stops a long-dead wait from escalating its project to warning", () => {
    const stale: WaitLite[] = [{ session: "beta:store", reason: "parked", at: T0 }];
    const now = T0 + STALL_WARN_MS * 200; // ~38h, the cli-typer case
    // Unguarded, this pins beta orange forever…
    expect(applyStallHealth(projects, stale, now).find((p) => p.id === "beta")).toMatchObject({ health: "warning" });
    // …guarded by liveness, the project keeps whatever its own state says.
    expect(applyStallHealth(projects, liveWaits(stale, new Set()), now)).toBe(projects);
  });
});

describe("applyFleetLiveStatus (#3252 — fleet-drill live agent status)", () => {
  const PROJ = "proj";
  // A planned fleet at rest — director + one worker + the preview node, all seeded idle by buildOrgFleetData.
  const nodes: GRawNode[] = [
    { id: "director", slug: "director", role: "infra", health: "off", activity: "idle" },
    { id: "auth", slug: "auth", role: "service", health: "off", activity: "idle" },
    { id: "__preview__", slug: "preview", role: "client", health: "healthy", activity: "live", preview: true },
  ];
  const dir = fleetPaneId(PROJ, "director"); // "proj:director"
  const auth = fleetPaneId(PROJ, "auth");
  const sig = (over: Partial<FleetLiveSignals>): FleetLiveSignals => ({
    livePaneIds: new Set(), paneStatus: {}, waiting: [], now: T0, ...over,
  });
  const out = (over: Partial<FleetLiveSignals>) => applyFleetLiveStatus(nodes, PROJ, sig(over));
  const node = (r: GRawNode[], id: string) => r.find((n) => n.id === id)!;

  // No session behind the node ⇒ `off`, distinct from a session that exists and is merely quiet.
  // While both read `idle`, an absent session was indistinguishable from a resting one — and its
  // (correctly) empty log view looked like a broken log rather than a session that was never launched.
  it("an UNLAUNCHED agent reads OFF — no session exists", () => {
    const r = out({}); // nothing launched
    expect(node(r, "director")).toMatchObject({ health: "off", activity: "idle" });
    expect(node(r, "auth")).toMatchObject({ health: "off", activity: "idle" });
  });

  it("a launched + RUNNING agent reads healthy · building — INCLUDING the director", () => {
    const r = out({ livePaneIds: new Set([dir, auth]), paneStatus: { [dir]: "run", [auth]: "run" } });
    expect(node(r, "director")).toMatchObject({ health: "healthy", activity: "building" });
    expect(node(r, "auth")).toMatchObject({ health: "healthy", activity: "building" });
  });

  it("a launched but QUIET agent reads HEALTHY with an idle activity word (#4042)", () => {
    // #4042 removed the `idle` HEALTH state: a session that exists with nothing wrong IS healthy, and
    // the activity word already carries "at rest". Two axes, two facts, no overlap.
    const r = out({ livePaneIds: new Set([dir]) }); // launched, not running, not waiting
    expect(node(r, "director")).toMatchObject({ health: "healthy", activity: "idle" });
    // ...and it is still NOT the same as a node with NO session — that one is `off`, which is what the
    // dimming conveys. This contrast is the whole reason both states exist.
    expect(node(r, "auth")).toMatchObject({ health: "off", activity: "idle" });
  });

  // #4005 CHANGED both of these. A `bsc-wait` used to read `healthy` (green, calm) for ten minutes and
  // only then flip to `warning`. Both readings were wrong in the same way: green says "nothing to do"
  // about a session waiting on YOU, and orange says "something is degrading" about a normal hand-off.
  // It is a request, so it gets its own health from the first moment.
  it("a launched agent parked on a bsc-wait reads HEALTHY + waiting, with its reason (#4046)", () => {
    const r = out({ livePaneIds: new Set([auth]), waiting: [{ session: auth, reason: "awaiting review", at: T0 - 60_000 }] });
    expect(node(r, "auth")).toMatchObject({ health: "healthy", activity: "waiting", reason: "awaiting review" });
  });

  it("an OVERSTAYED wait still reads waiting, and adds the duration", () => {
    // How long it has been waiting is still worth knowing — it is just no longer the thing that
    // makes it visible in the first place.
    const r = out({ livePaneIds: new Set([auth]), waiting: [{ session: auth, reason: "no instructions", at: T0 - 12 * 60_000 }] });
    expect(node(r, "auth")).toMatchObject({ health: "healthy", activity: "waiting", reason: "no instructions · 12m" });
  });

  it("a pane STOPPED at a permission prompt reads HEALTHY + waiting (#4005/#4046)", () => {
    // The signal nothing in the app could see before: not `run`, no `bsc-wait`, so it fell through to
    // plain `idle` and looked exactly like a session that had simply finished.
    const r = out({ livePaneIds: new Set([auth]), attention: new Set([auth]) });
    expect(node(r, "auth")).toMatchObject({ health: "healthy", activity: "waiting" });
    expect(node(r, "auth").reason).toMatch(/permission/);
  });

  it("a bsc-wait outranks the permission signal — its reason is the specific one", () => {
    const r = out({
      livePaneIds: new Set([auth]),
      attention: new Set([auth]),
      waiting: [{ session: auth, reason: "awaiting review", at: T0 - 60_000 }],
    });
    expect(node(r, "auth").reason).toBe("awaiting review");
  });

  it("quarantine still outranks attention — that one is a fault the user must clear", () => {
    const r = out({ livePaneIds: new Set([auth]), attention: new Set([auth]), quarantined: { [auth]: { summary: "warden" } } });
    expect(node(r, "auth")).toMatchObject({ health: "error" });
  });

  it("an attention pane that is NOT launched stays off — no session, nothing to answer", () => {
    const r = out({ attention: new Set([auth]) });
    expect(node(r, "auth")).toMatchObject({ health: "off", activity: "idle" });
  });

  it("waiting beats running (a parked session isn't 'building' even if its pane still reads run)", () => {
    const r = out({ livePaneIds: new Set([auth]), paneStatus: { [auth]: "run" }, waiting: [{ session: auth, reason: "hold", at: T0 - 60_000 }] });
    expect(node(r, "auth").activity).toBe("waiting");
  });

  it("the preview node is left untouched (not an agent)", () => {
    const r = out({ livePaneIds: new Set([dir, auth]), paneStatus: { [dir]: "run" } });
    expect(node(r, "__preview__")).toEqual(nodes[2]); // healthy/live/preview, unchanged
  });
});

describe("applyFleetLiveStatus — quarantine is a first-class node state (#3916)", () => {
  const nodes = [{ id: "api" }, { id: "ui" }] as never as Parameters<typeof applyFleetLiveStatus>[0];
  const base = { livePaneIds: new Set<string>(), paneStatus: {}, waiting: [], now: 0 };

  it("shows a quarantined agent as ERROR with the warden's reason, not as `off`", () => {
    // The warden KILLS the PTY when it quarantines, so the pane is never live — without this overlay the
    // node fell through to `off`, reading as "never launched" rather than "hard-paused, here is why".
    const out = applyFleetLiveStatus(nodes, "proj", {
      ...base,
      quarantined: { "proj:ui": { summary: "wrote outside its lane" } },
    });
    const ui = out.find((n) => n.id === "ui")!;
    expect(ui.health).toBe("error");
    expect(ui.reason).toBe("wrote outside its lane");
    // An unquarantined, unlaunched sibling still reads `off` — the overlay is targeted, not blanket.
    expect(out.find((n) => n.id === "api")!.health).toBe("off");
  });

  it("falls back to a readable reason when the quarantine carries no summary", () => {
    const out = applyFleetLiveStatus(nodes, "proj", { ...base, quarantined: { "proj:api": {} } });
    expect(out.find((n) => n.id === "api")!.reason).toBe("quarantined by the warden");
  });

  it("is inert when nothing is quarantined (pre-#3916 behaviour byte-for-byte)", () => {
    expect(applyFleetLiveStatus(nodes, "proj", base)).toEqual(applyFleetLiveStatus(nodes, "proj", { ...base, quarantined: {} }));
  });
});

describe("applyFleetLiveStatus — held by the dependency gate (#3931)", () => {
  const node = (id: string): GRawNode => ({ id, slug: id, role: "service", health: "off", activity: "idle" });
  const base = { paneStatus: {}, waiting: [], now: Date.now() };

  it("a held stream explains itself instead of rendering as an anonymous dark node", () => {
    const [n] = applyFleetLiveStatus([node("play-screen")], "proj", {
      ...base,
      livePaneIds: new Set(),
      held: { "play-screen": { reason: "waiting on game-modes to land", deadlocked: false } },
    });
    expect(n.health).toBe("off");            // still no session — that part was never wrong
    expect(n.activity).toBe("waiting");
    expect(n.reason).toBe("waiting on game-modes to land");
  });

  it("a DEADLOCKED stream is an error — it can never start on its own", () => {
    const [n] = applyFleetLiveStatus([node("a")], "proj", {
      ...base,
      livePaneIds: new Set(),
      held: { a: { reason: "dependency cycle — cannot start (waiting on b)", deadlocked: true } },
    });
    expect(n.health).toBe("error");
    expect(n.reason).toContain("cycle");
  });

  it("a held stream that is somehow LIVE reports its real live state, not the stale hold", () => {
    // The held map is computed asynchronously; a stream released between the probe and the render must
    // not be painted as waiting.
    const [n] = applyFleetLiveStatus([node("a")], "proj", {
      ...base,
      livePaneIds: new Set(["proj:a"]),
      paneStatus: { "proj:a": "run" },
      held: { a: { reason: "waiting on b to land", deadlocked: false } },
    });
    expect(n.health).toBe("healthy");
    expect(n.activity).toBe("building");
  });

  it("QUARANTINE outranks a hold — it is the state the user must act on", () => {
    const [n] = applyFleetLiveStatus([node("a")], "proj", {
      ...base,
      livePaneIds: new Set(),
      quarantined: { "proj:a": { summary: "denied command" } },
      held: { a: { reason: "waiting on b to land", deadlocked: false } },
    });
    expect(n.health).toBe("error");
    expect(n.reason).toBe("denied command");
  });

  it("no held map ⇒ the pre-#3931 behaviour is unchanged", () => {
    const [n] = applyFleetLiveStatus([node("a")], "proj", { ...base, livePaneIds: new Set() });
    expect(n.health).toBe("off");
    expect(n.reason).toBeUndefined();
  });
});

describe("maintenance vs building (#4010)", () => {
  const PROJ = "proj";
  const nodes: GRawNode[] = [{ id: "auth", slug: "auth", role: "service", health: "off", activity: "idle" }];
  const auth = fleetPaneId(PROJ, "auth");
  const run = (over: Partial<FleetLiveSignals>) =>
    applyFleetLiveStatus(nodes, PROJ, { livePaneIds: new Set([auth]), paneStatus: {}, waiting: [], now: T0, ...over })[0];

  it("a working session reads building — the state that wears the outline", () => {
    expect(run({ paneStatus: { [auth]: "run" } })).toMatchObject({ health: "healthy", activity: "building" });
  });

  it("a PARKED session does not read as building, even while its pane still reads run", () => {
    // The #4010 point, unchanged: a maintaining worker's TUI is still alive, so `paneStatus` may well
    // be "run"; checked after the run->building branch it would keep breathing forever despite having
    // finished everything it owns.
    //
    // The WORD changed in #4027 — `complete`, not `idle`. Standing by having finished everything and
    // merely being quiet are different facts, and they used to render identically.
    const r = run({ paneStatus: { [auth]: "run" }, maintaining: new Set([auth]) });
    // #4034 — health is `complete` (blue) too now, not `idle` (grey). A finished worker and a resting
    // one are different states and used to share a colour.
    expect(r).toMatchObject({ health: "complete", activity: "complete" });
    expect(r.reason).toMatch(/maintenance/);
  });

  it("keeps the explanation on the node so the plain rendering is not information-free", () => {
    // It renders as the plain node deliberately — nothing for anyone to do — but hover and the
    // inspector's REASON tile still say why it is quiet.
    expect(run({ maintaining: new Set([auth]) }).reason).toMatch(/standing by/);
  });

  it("a bsc-wait still outranks maintenance — that one needs a person", () => {
    const r = run({ maintaining: new Set([auth]), waiting: [{ session: auth, reason: "awaiting review", at: T0 }] });
    expect(r).toMatchObject({ health: "healthy", activity: "waiting" });
  });

  it("quarantine still outranks maintenance", () => {
    const r = run({ maintaining: new Set([auth]), quarantined: { [auth]: { summary: "warden" } } });
    expect(r).toMatchObject({ health: "error" });
  });

  it("maintenance on an unlaunched node stays off — there is no session to park", () => {
    const r = applyFleetLiveStatus(nodes, PROJ, {
      livePaneIds: new Set(), paneStatus: {}, waiting: [], now: T0, maintaining: new Set([auth]),
    })[0];
    expect(r).toMatchObject({ health: "off", activity: "idle" });
  });
});

describe("a finished worker reads COMPLETE (#4027)", () => {
  const PROJ = "proj";
  const nodes: GRawNode[] = [{ id: "auth", slug: "auth", role: "service", health: "off", activity: "idle" }];
  const auth = fleetPaneId(PROJ, "auth");
  const run = (over: Partial<FleetLiveSignals>) =>
    applyFleetLiveStatus(nodes, PROJ, { livePaneIds: new Set([auth]), paneStatus: {}, waiting: [], now: T0, ...over })[0];

  it("an ENDED-done worker reads complete, NOT off", () => {
    // The trap: `livePaneIds` excludes ended panes, so without a branch above the off fall-through a
    // worker that completed every issue renders identically to one that never launched.
    const r = applyFleetLiveStatus(nodes, PROJ, {
      livePaneIds: new Set(), paneStatus: {}, waiting: [], now: T0,
      ended: { [auth]: { state: "done" } },
    })[0];
    expect(r.activity).toBe("complete");
    expect(r.health).not.toBe("off");
  });

  it("a MAINTAINING worker reads complete, not idle", () => {
    // Standing by having finished everything vs merely being quiet are different facts; they used to
    // render as the same word.
    expect(run({ maintaining: new Set([auth]) })).toMatchObject({ activity: "complete" });
  });

  it("an ending that WANTS A PERSON does not read complete", () => {
    // `needs-attention` / `blocked` are endings too — but endings that need someone, so they keep
    // falling through to the states that say so rather than being dressed up as success.
    for (const state of ["needs-attention", "blocked"]) {
      const r = applyFleetLiveStatus(nodes, PROJ, {
        livePaneIds: new Set(), paneStatus: {}, waiting: [], now: T0, ended: { [auth]: { state } },
      })[0];
      expect(r.activity).not.toBe("complete");
    }
  });

  it("a never-launched worker still reads off — the distinction the branch exists to protect", () => {
    const r = applyFleetLiveStatus(nodes, PROJ, { livePaneIds: new Set(), paneStatus: {}, waiting: [], now: T0 })[0];
    expect(r).toMatchObject({ health: "off", activity: "idle" });
  });

  it("quarantine still outranks complete", () => {
    const r = run({ maintaining: new Set([auth]), quarantined: { [auth]: { summary: "warden" } } });
    expect(r).toMatchObject({ health: "error" });
  });

  it("complete never pulses — motion means 'look at this', and this needs nothing", () => {
    expect(ACTIVITY_META.complete.pulse).toBe(false);
    expect(ACTIVITY_META.complete.label).toBe("complete");
  });
});
