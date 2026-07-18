import { describe, it, expect } from "vitest";
import { applyStallHealth, applyFleetLiveStatus, projectKeyOfSession, STALL_WARN_MS, type WaitLite, type FleetLiveSignals } from "./agentStall";
import type { ProjectLite } from "./glanceData";
import type { GRawNode } from "./glanceGraph";
import { fleetPaneId } from "@/app/console/lib/paneIdentity";

const T0 = 1_720_000_000_000; // a fixed "now" base
const projects: ProjectLite[] = [
  { id: "alpha", name: "Alpha", health: "healthy", activity: "building" },
  { id: "beta", name: "Beta", health: "idle", activity: "building" },
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

describe("applyFleetLiveStatus (#3252 — fleet-drill live agent status)", () => {
  const PROJ = "proj";
  // A planned fleet at rest — director + one worker + the preview node, all seeded idle by buildOrgFleetData.
  const nodes: GRawNode[] = [
    { id: "director", slug: "director", role: "infra", health: "idle", activity: "idle" },
    { id: "auth", slug: "auth", role: "service", health: "idle", activity: "idle" },
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

  it("a launched but QUIET agent (between prompts) reads idle — it EXISTS but is not working", () => {
    const r = out({ livePaneIds: new Set([dir]) }); // launched, not running, not waiting
    expect(node(r, "director")).toMatchObject({ health: "idle", activity: "idle" });
    // ...and it is NOT the same as a node with no session at all — that one is `off`.
    expect(node(r, "auth")).toMatchObject({ health: "off", activity: "idle" });
  });

  it("a launched agent parked on a FRESH bsc-wait reads healthy · waiting", () => {
    const r = out({ livePaneIds: new Set([auth]), waiting: [{ session: auth, reason: "awaiting review", at: T0 - 60_000 }] });
    expect(node(r, "auth")).toMatchObject({ health: "healthy", activity: "waiting" });
    expect(node(r, "auth").reason).toBeUndefined();
  });

  it("an OVERSTAYED wait escalates to warning · waiting with a duration reason", () => {
    const r = out({ livePaneIds: new Set([auth]), waiting: [{ session: auth, reason: "no instructions", at: T0 - 12 * 60_000 }] });
    expect(node(r, "auth")).toMatchObject({ health: "warning", activity: "waiting", reason: "no instructions · 12m" });
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
