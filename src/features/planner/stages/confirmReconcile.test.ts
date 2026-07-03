import { describe, it, expect } from "vitest";
import { reconcileConfirmations, type ConfirmRow } from "./confirmReconcile";
import { hashString } from "@/shared/lib/core/hashString";

const row = (stage: string, content: string): ConfirmRow => ({ stage, fingerprint: hashString(content) });

describe("reconcileConfirmations (#2256)", () => {
  it("rehydrates a durably-confirmed stage whose content is unchanged and absent from the store", () => {
    const rows = [row("goal", "the goal"), row("scope", "the scope")];
    const live = { goal: "the goal", scope: "the scope" };
    const r = reconcileConfirmations(rows, live, new Set(), false);
    expect(r.rehydrate.sort()).toEqual(["goal", "scope"]);
    expect(r.reset).toEqual([]);
    expect(r.migrate).toEqual([]);
  });

  it("does NOT re-rehydrate a stage already in the store (no churn)", () => {
    const rows = [row("goal", "the goal")];
    const r = reconcileConfirmations(rows, { goal: "the goal" }, new Set(["goal"]), false);
    expect(r.rehydrate).toEqual([]);
    expect(r.reset).toEqual([]);
  });

  it("resets JUST the stage whose content changed since confirm", () => {
    const rows = [row("goal", "the goal"), row("scope", "the scope")];
    // goal was edited (live differs from the confirmed fingerprint); scope is unchanged.
    const live = { goal: "the goal, revised", scope: "the scope" };
    const r = reconcileConfirmations(rows, live, new Set(["goal", "scope"]), false);
    expect(r.reset).toEqual(["goal"]);
    expect(r.rehydrate).toEqual([]); // scope already in store, unchanged → left alone
  });

  it("treats a now-missing/empty section as a change (resets it)", () => {
    const rows = [row("goal", "the goal")];
    const r = reconcileConfirmations(rows, {}, new Set(["goal"]), false);
    expect(r.reset).toEqual(["goal"]);
  });

  it("forward-migrates app-state-only confirmations when plan.db has none", () => {
    const r = reconcileConfirmations([], { goal: "g", scope: "s" }, new Set(["goal", "scope"]), false);
    expect(r.migrate.sort()).toEqual(["goal", "scope"]);
    expect(r.rehydrate).toEqual([]);
    expect(r.reset).toEqual([]);
  });

  it("does not re-migrate once migrated (guard)", () => {
    const r = reconcileConfirmations([], { goal: "g" }, new Set(["goal"]), true);
    expect(r.migrate).toEqual([]);
  });

  it("no-ops cleanly when both plan.db and the store are empty (fresh legacy project)", () => {
    const r = reconcileConfirmations([], {}, new Set(), false);
    expect(r).toEqual({ rehydrate: [], reset: [], migrate: [] });
  });
});
