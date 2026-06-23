import { describe, it, expect } from "vitest";
import { emptyCoordState, parseRef, type CoordState, type Waiter, type WaitingSession } from "../fleet/coordination";
import { planMobileResume } from "./coordControl";

const dep = parseRef("42")!; // an issue ref

function waiter(session: string): Waiter {
  return { session, deps: [dep], registeredAt: 0 };
}
function paused(session: string, reason = "ship the migration?"): WaitingSession {
  return { session, reason, at: 0 };
}
function stateWith(over: Partial<CoordState>): CoordState {
  return { ...emptyCoordState(), ...over };
}

describe("planMobileResume (#935)", () => {
  it("approve resolves a session paused for the user, delivered into the live pane", () => {
    const state = stateWith({ waiting: [paused("api")] });
    const plan = planMobileResume("approve", "api", state, []);
    expect(plan).toMatchObject({ session: "api", via: "inject" });
    expect(plan!.prompt).toMatch(/resumed/i);
    expect(plan!.prompt).toContain("ship the migration?");
  });

  it("approve ignores a session that isn't paused (never approves blindly)", () => {
    const state = stateWith({ waiting: [paused("api")] });
    expect(planMobileResume("approve", "web", state, [])).toBeNull();
  });

  it("approve does not act on a mere dependency waiter (only a user-paused gate)", () => {
    const state = stateWith({ waiters: [waiter("web")] });
    expect(planMobileResume("approve", "web", state, [waiter("web")])).toBeNull();
  });

  it("wake relaunches a dependency waiter whose deps have landed", () => {
    const ready = [waiter("web")];
    const plan = planMobileResume("wake", "web", emptyCoordState(), ready);
    expect(plan).toMatchObject({ session: "web", via: "fresh" });
    expect(plan!.prompt).toMatch(/landed/i);
  });

  it("wake on a user-paused session resumes it in place", () => {
    const state = stateWith({ waiting: [paused("api", "")] });
    const plan = planMobileResume("wake", "api", state, []);
    expect(plan).toMatchObject({ session: "api", via: "inject" });
  });

  it("wake ignores a session that is neither ready nor paused", () => {
    expect(planMobileResume("wake", "ghost", emptyCoordState(), [])).toBeNull();
  });

  it("prefers the ready-dependency wake when a session is both ready and paused", () => {
    const state = stateWith({ waiting: [paused("web")] });
    const plan = planMobileResume("wake", "web", state, [waiter("web")]);
    expect(plan).toMatchObject({ via: "fresh" }); // a landed dep is a fresh relaunch
  });
});
