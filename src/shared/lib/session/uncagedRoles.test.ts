import { describe, it, expect } from "vitest";
import { UNCAGED_ROLES, isUncagedRole, sandboxPlanFor } from "@/app/console/lib/sessionLaunch";
import type { AppStore } from "@/store/types";

// THE SAME LIST as `UNCAGED_ROLES` in `bsc-sandbox--profile.rs`. The two decide the same question on
// opposite sides of the bridge: Rust decides whether to CAGE, the frontend decides whether to write
// the `/bsc-hook` guest paths that only exist inside a cage. When they disagreed, every launch of
// these panes wrote hooks Rust then had to repair — 13 repairs in one app run, the notice printed in
// the pane each time, because the writer kept regenerating what the repair had just fixed.
const RUST_UNCAGED = ["designer", "architect", "librarian", "director", "integrator", "operator"];

const state = (role: string | undefined) =>
  ({ paneRoles: role ? { p: role } : {}, sandboxConsoles: false, paneWslDistro: {} } as unknown as AppStore);

describe("uncaged roles — the backend's list, mirrored", () => {
  it("matches the Rust list exactly", () => {
    expect([...UNCAGED_ROLES].sort()).toEqual([...RUST_UNCAGED].sort());
  });

  it("recognises each one, and nothing else", () => {
    for (const r of RUST_UNCAGED) expect(isUncagedRole(r as never), r).toBe(true);
    for (const r of ["worker", "tester", "reviewer", "triage", "juror"]) {
      expect(isUncagedRole(r as never), r).toBe(false);
    }
    expect(isUncagedRole(undefined)).toBe(false);
  });

  it("does NOT plan a namespace for a role the backend will refuse to cage", () => {
    // The bug: a director got backend "namespace", so `namespaceHooks` was true and the settings
    // writer emitted `/bsc-hook` — a path that exists only inside a cage the backend then declined.
    const plan = sandboxPlanFor(state("director"), "p", true);
    expect(plan.backend).not.toBe("namespace");
    expect(plan.namespaceHooks).toBe(false);
    expect(plan.role).toBeUndefined();
  });

  it("still plans a namespace for a role the backend WILL cage", () => {
    // The fix must not disable caging generally — a worker is exactly what the cage is for.
    const plan = sandboxPlanFor(state("worker"), "p", true);
    expect(plan.backend).toBe("namespace");
    expect(plan.namespaceHooks).toBe(true);
    expect(plan.role).toBe("worker");
  });

  it("plans nothing for a pane with no role at all", () => {
    expect(sandboxPlanFor(state(undefined), "p", true).backend).not.toBe("namespace");
  });
});
