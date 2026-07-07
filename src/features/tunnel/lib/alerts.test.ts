// Alert taxonomy (#2498) — derivation from the coord state / transitions, dedup, and the cap.
import { describe, it, expect } from "vitest";
import { emptyCoordState } from "@/shared/lib/fleet/coordination";
import type { CoordState } from "@/shared/lib/fleet/coordination";
import {
  coordAlerts, promptAlerts, gateReadyAlert, plannerWaitingAlert,
  foldAlerts, alertPushFields, ALERT_INBOX_CAP,
  type AlertEvent,
} from "./alerts";

const coordState = (over: Partial<CoordState> = {}): CoordState => ({ ...emptyCoordState(), ...over });

const alert = (id: string, at = 1000): AlertEvent => ({ id, kind: "fleet-landed", text: id, at });

describe("coordAlerts", () => {
  it("maps waiting → agent-paused with the reason and the log timestamp", () => {
    const [a] = coordAlerts(coordState({
      waiting: [{ session: "demo:auth", reason: "checkpoint before push", at: 42 }],
    }));
    expect(a).toMatchObject({
      id: "agent-paused:demo:auth:42",
      kind: "agent-paused",
      paneId: "demo:auth",
      text: "checkpoint before push",
      at: 42,
    });
  });

  it("maps asking → worker-question carrying the question", () => {
    const [a] = coordAlerts(coordState({
      asking: [{ session: "demo:api", question: "Which port?", at: 7 }],
    }));
    expect(a).toMatchObject({ id: "worker-question:demo:api:7", kind: "worker-question", text: "Which port?" });
  });

  it("maps latches: failed → fleet-failed (with reason), satisfied → fleet-landed (with source)", () => {
    const out = coordAlerts(coordState({
      latches: {
        "#42": { state: "failed", reason: "CI red", at: 5 },
        "#43": { state: "satisfied", source: "merged", at: 6 },
      },
    }));
    const failed = out.find((a) => a.kind === "fleet-failed");
    const landed = out.find((a) => a.kind === "fleet-landed");
    expect(failed).toMatchObject({ id: "fleet-failed:#42:5", text: "#42 failed: CI red" });
    expect(landed).toMatchObject({ id: "fleet-landed:#43:6", text: "#43 merged" });
  });

  it("is idempotent — the same replayed state derives identical ids", () => {
    const s = coordState({ waiting: [{ session: "w", reason: "", at: 9 }] });
    expect(coordAlerts(s)).toEqual(coordAlerts(s));
  });

  it("gives an empty-reason wait a meaningful line", () => {
    const [a] = coordAlerts(coordState({ waiting: [{ session: "w1", reason: "", at: 1 }] }));
    expect(a.text).toContain("w1");
  });
});

describe("promptAlerts", () => {
  it("alerts only panes that JUST entered the awaiting set", () => {
    const prev = [{ paneId: "man:t1:p0", name: "api" }];
    const next = [
      { paneId: "man:t1:p0", name: "api" },
      { paneId: "demo:auth", name: "auth worker" },
    ];
    const out = promptAlerts(prev, next, 500);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "prompt-waiting:demo:auth:500",
      kind: "prompt-waiting",
      paneId: "demo:auth",
      text: "auth worker is waiting for your input.",
      at: 500,
    });
  });

  it("re-alerts a pane that resolved and awaits again (new timestamp, new id)", () => {
    const pane = [{ paneId: "p", name: "n" }];
    const first = promptAlerts([], pane, 1)[0];
    const second = promptAlerts([], pane, 2)[0];
    expect(first.id).not.toBe(second.id);
  });
});

describe("gateReadyAlert / plannerWaitingAlert", () => {
  it("gate-ready names the stage and the project", () => {
    const a = gateReadyAlert("demo", "features", 10);
    expect(a).toMatchObject({ id: "gate-ready:demo:features:10", kind: "gate-ready", project: "demo" });
    expect(a.text).toContain("features");
  });

  it("planner-waiting is keyed by the turn timestamp and truncates the turn text", () => {
    const a = plannerWaitingAlert("demo", "planning_demo", "x".repeat(400), 77);
    expect(a.id).toBe("planner-waiting:planning_demo:77");
    expect(a.text.length).toBeLessThanOrEqual(140);
    const blank = plannerWaitingAlert("demo", "planning_demo", "   ", 78);
    expect(blank.text).toBe("The planner is waiting for you.");
  });
});

describe("foldAlerts", () => {
  it("drops candidates already in the inbox and returns only the fresh ones", () => {
    const inbox = [alert("a"), alert("b")];
    const { inbox: next, fresh } = foldAlerts(inbox, [alert("b"), alert("c")]);
    expect(fresh.map((a) => a.id)).toEqual(["c"]);
    expect(next.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it("returns the SAME inbox reference when nothing is new (cheap no-op for effects)", () => {
    const inbox = [alert("a")];
    const { inbox: next, fresh } = foldAlerts(inbox, [alert("a")]);
    expect(fresh).toEqual([]);
    expect(next).toBe(inbox);
  });

  it("dedups within one candidate batch and appends in `at` order", () => {
    const { inbox, fresh } = foldAlerts([], [alert("x", 30), alert("y", 10), alert("x", 30)]);
    expect(fresh.map((a) => a.id)).toEqual(["y", "x"]);
    expect(inbox.map((a) => a.id)).toEqual(["y", "x"]);
  });

  it("caps the inbox at the newest ALERT_INBOX_CAP entries", () => {
    let inbox: ReadonlyArray<AlertEvent> = [];
    for (let i = 0; i < ALERT_INBOX_CAP + 25; i++) {
      inbox = foldAlerts(inbox, [alert(`a${i}`, i)]).inbox;
    }
    expect(inbox).toHaveLength(ALERT_INBOX_CAP);
    expect(inbox[0].id).toBe("a25"); // the 25 oldest fell off
    expect(inbox[inbox.length - 1].id).toBe(`a${ALERT_INBOX_CAP + 24}`);
  });
});

describe("alertPushFields", () => {
  it("titles per kind and scopes to the pane/session when present", () => {
    const f = alertPushFields({ id: "i", kind: "worker-question", paneId: "demo:api", text: "Which port?", at: 1 });
    expect(f).toEqual({ title: "Worker question — demo:api", body: "Which port?" });
  });

  it("falls back to the project, then to the bare kind title", () => {
    expect(alertPushFields({ id: "i", kind: "gate-ready", project: "demo", text: "t", at: 1 }).title)
      .toBe("Plan stage ready — demo");
    expect(alertPushFields({ id: "i", kind: "fleet-landed", text: "t", at: 1 }).title)
      .toBe("Fleet: landed");
  });
});
