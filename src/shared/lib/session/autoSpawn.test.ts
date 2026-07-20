import { describe, it, expect } from "vitest";
import {
  AUTO_SPAWNABLE_ROLE,
  allSessionRoles,
  autoSpawnDecision,
  mayAutoSpawn,
} from "./autoSpawn";

describe("the auto-spawn gate (#3498)", () => {
  it("refuses EVERY role except the debugger, enumerating the real role union", () => {
    // THE assertion this gate exists for. `allSessionRoles()` reads the runtime union, so a role added
    // to `SessionRole` later is covered automatically — it cannot quietly inherit auto-spawn by being
    // forgotten here. An allow-list of one; never a deny-list.
    const roles = allSessionRoles();
    expect(roles.length, "the role union must be enumerable, else this test proves nothing").toBeGreaterThan(5);
    expect(roles, "the debugger must be a real role").toContain(AUTO_SPAWNABLE_ROLE);

    for (const role of roles) {
      const allowed = mayAutoSpawn({ role, enabled: true });
      if (role === AUTO_SPAWNABLE_ROLE) {
        expect(allowed, `${role} is the one auto-spawnable role`).toBe(true);
      } else {
        expect(allowed, `${role} must NEVER be auto-spawnable`).toBe(false);
      }
    }
  });

  it("refuses even the debugger while the setting is off — the toggle is the outer gate", () => {
    expect(mayAutoSpawn({ role: AUTO_SPAWNABLE_ROLE, enabled: false })).toBe(false);
  });

  it("fails CLOSED on anything that is not literally true", () => {
    // A missing/corrupted setting must DISABLE auto-spawn, never enable it. These are the shapes a
    // persisted store can actually produce.
    for (const enabled of [undefined, null, false] as const) {
      expect(mayAutoSpawn({ role: AUTO_SPAWNABLE_ROLE, enabled }), `enabled=${String(enabled)}`).toBe(false);
    }
    // …and a missing role is refused too, rather than defaulting to the privileged one.
    for (const role of [undefined, null] as const) {
      expect(mayAutoSpawn({ role, enabled: true }), `role=${String(role)}`).toBe(false);
    }
  });

  it("names WHY it refused — a blocked spawn must be diagnosable, not silent", () => {
    const off = autoSpawnDecision({ role: AUTO_SPAWNABLE_ROLE, enabled: false });
    expect(off.allowed).toBe(false);
    expect(off.allowed === false && off.reason).toMatch(/disabled|Settings/i);

    const wrongRole = autoSpawnDecision({ role: "designer", enabled: true });
    expect(wrongRole.allowed).toBe(false);
    // The reason must name both the offending role and the only permitted one.
    expect(wrongRole.allowed === false && wrongRole.reason).toContain("designer");
    expect(wrongRole.allowed === false && wrongRole.reason).toContain(AUTO_SPAWNABLE_ROLE);
  });

  it("blames the SETTING first when both conditions fail", () => {
    // With auto-spawn off, a designer must be told auto-spawn is off — not that its role is wrong,
    // which would send someone chasing a permissions problem that isn't the actual blocker.
    const d = autoSpawnDecision({ role: "designer", enabled: false });
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toMatch(/disabled/i);
  });

  it("the sole auto-spawnable role is the debugger", () => {
    // Pins the constant itself: a change here is a change to the security boundary and should show up
    // in review as exactly that, not buried in a diff.
    expect(AUTO_SPAWNABLE_ROLE).toBe("debugger");
  });
});
