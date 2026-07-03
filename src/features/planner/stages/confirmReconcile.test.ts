import { describe, it, expect } from "vitest";
import { reconcileConfirmations, reconcileSkips, stagesToBackfill, type ConfirmRow, type SectionState } from "./confirmReconcile";
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

describe("stagesToBackfill (#2259)", () => {
  const secs = (o: Record<string, SectionState["state"]>): SectionState[] =>
    Object.entries(o).map(([k, state]) => ({ k, state }));

  it("backfills every drafted section (a published project's authored sections)", () => {
    const s = secs({ goal: "drafted", scope: "drafted", stack: "drafted" });
    expect(stagesToBackfill(s, new Set()).sort()).toEqual(["goal", "scope", "stack"]);
  });

  it("skips pending (no-content) sections — nothing was confirmed there", () => {
    const s = secs({ goal: "drafted", api: "pending", security: "pending" });
    expect(stagesToBackfill(s, new Set())).toEqual(["goal"]);
  });

  it("skips sections already confirmed (idempotent restore)", () => {
    const s = secs({ goal: "drafted", scope: "drafted" });
    expect(stagesToBackfill(s, new Set(["goal"]))).toEqual(["scope"]);
  });

  it("returns nothing before any section content has loaded", () => {
    expect(stagesToBackfill(secs({ goal: "pending" }), new Set())).toEqual([]);
    expect(stagesToBackfill([], new Set())).toEqual([]);
  });
});

describe("reconcileSkips (#2267)", () => {
  it("rehydrates durable skips missing from the store", () => {
    const r = reconcileSkips(["api", "security"], new Set(), false);
    expect(r.rehydrate.sort()).toEqual(["api", "security"]);
    expect(r.migrate).toEqual([]);
  });

  it("does not re-rehydrate a skip already in the store", () => {
    const r = reconcileSkips(["api"], new Set(["api"]), false);
    expect(r.rehydrate).toEqual([]);
  });

  it("forward-migrates app-state-only skips when plan.db has none", () => {
    const r = reconcileSkips([], new Set(["api", "security"]), false);
    expect(r.migrate.sort()).toEqual(["api", "security"]);
    expect(r.rehydrate).toEqual([]);
  });

  it("does not re-migrate once migrated (guard)", () => {
    expect(reconcileSkips([], new Set(["api"]), true).migrate).toEqual([]);
  });

  it("no-ops cleanly when plan.db and the store are both empty", () => {
    expect(reconcileSkips([], new Set(), false)).toEqual({ rehydrate: [], migrate: [] });
  });
});
