import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { flowForTier, buildRemovalKickoff, refactorUnitsToFleet, startCleanupFleet } from "../screens/planner/refactorFleet";
import { type RefactorUnit } from "../lib/refactorUnits";
import { type VerifiedFinding } from "../lib/deadcodeVerify";
import { useAppStore } from "../store";

const unit = (over: Partial<RefactorUnit> = {}): RefactorUnit => ({
  id: "src/a.ts", title: "Remove dead items in src/a.ts", owns: ["src/a.ts"], tier: "risky",
  findings: [{ kind: "unused-export", path: "src/a.ts", symbol: "Foo", detail: "", tool: "ts-prune", confidence: "medium", verdict: "confirmed", reason: "" }],
  acceptance: "Tests pass and re-scan clean.", ...over,
});

describe("flowForTier (#626 slice d2)", () => {
  it("safe = auto-pr/continuous; risky = push-confirm/checkpoint", () => {
    expect(flowForTier("safe")).toMatchObject({ push: "auto-pr", autonomy: "continuous" });
    expect(flowForTier("risky")).toMatchObject({ push: "push-confirm", autonomy: "checkpoint" });
  });
});

describe("buildRemovalKickoff (#626)", () => {
  it("lists the items + the don't-remove-if-referenced rule + acceptance", () => {
    const k = buildRemovalKickoff(unit(), "acme/web");
    expect(k).toMatch(/acme\/web/);
    expect(k).toMatch(/`Foo` in src\/a\.ts/);
    expect(k).toMatch(/do not remove it/i);
    expect(k).toMatch(/re-?scan/i);
    expect(k).toMatch(/Tests pass/);
  });
});

describe("refactorUnitsToFleet (#626)", () => {
  it("maps units → streams with disjoint owns, tier flows, and kickoff paths", () => {
    const fleet = refactorUnitsToFleet([unit({ id: "deps", tier: "safe", owns: ["package.json"] }), unit()], "acme/web");
    expect(fleet.streams).toHaveLength(2);
    expect(fleet.recommended).toBe(2);
    const deps = fleet.streams.find((s) => s.id === "cleanup-deps")!;
    expect(deps.repo).toBe("acme/web");
    expect(deps.owns).toEqual(["package.json"]);
    expect(deps.flow!.push).toBe("auto-pr");
    expect(deps.prompt).toBe("prompts/cleanup-deps-kickoff.md");
    // risky file unit id is sanitized
    expect(fleet.streams.some((s) => s.id === "cleanup-src_a_ts")).toBe(true);
    expect(fleet.director.enabled).toBe(true); // >1 stream
  });
});

describe("startCleanupFleet (#626)", () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); vi.mocked(invoke).mockResolvedValue(undefined); });

  it("no confirmed findings ⇒ no launch", async () => {
    const spy = vi.spyOn(useAppStore.getState(), "fleetStartProject");
    const out = await startCleanupFleet({ projectName: "P", projectKey: "p", repo: "acme/web", verified: [] });
    expect(out).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("writes a kickoff per unit and launches the fleet", async () => {
    const launched: unknown[] = [];
    const spy = vi.spyOn(useAppStore.getState(), "fleetStartProject").mockImplementation((...a) => { launched.push(a); return []; });
    const verified: VerifiedFinding[] = [
      { kind: "unused-dep", path: "package.json", symbol: "lodash", detail: "", tool: "depcheck", confidence: "medium", verdict: "confirmed", reason: "" },
      { kind: "unused-export", path: "src/a.ts", symbol: "Foo", detail: "", tool: "ts-prune", confidence: "medium", verdict: "confirmed", reason: "" },
    ];
    const units = await startCleanupFleet({ projectName: "P", projectKey: "p", repo: "acme/web", verified });
    expect(units).toHaveLength(2); // deps batch + one file unit
    // a write_project_file invoke per kickoff
    const writes = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "write_project_file");
    expect(writes).toHaveLength(2);
    expect(launched).toHaveLength(1);
    spy.mockRestore();
  });
});
