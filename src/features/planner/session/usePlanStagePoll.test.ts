// #1805: plan.db is the SOLE fleet store — usePlanStagePoll must never read a fleet.json file.
// These tests pin that the fleet section is sourced from plan.db (`bsc plan fleet get`) and that a
// `fleet` key leaking out of `read_plan_stages` (a stray on-disk file) is ignored, while ordinary
// section files still flow through.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { usePlanStagePoll } from "./usePlanStagePoll";
import { FLEET_KEY } from "../fleet/planFleet";

const PID = "p-fleet-poll";

const render = () =>
  renderHook(() =>
    usePlanStagePoll({ visible: true, projectId: PID, publishRepos: [], enqueueMcpDownloads: () => {}, planningDir: "" }),
  );

describe("usePlanStagePoll — fleet is plan.db-only (#1805)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ planStages: {}, planConfirmedStages: {} });
  });
  afterEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("sources the fleet section from plan.db and ignores a stray fleet.json key from the file sweep", async () => {
    const dbFleet = { recommended: 3, streams: [{ id: "db", repo: "o/db" }] };
    vi.mocked(invoke).mockImplementation(async (cmd: string, payload?: unknown) => {
      // Every plan.db read now routes through the generic `bsc` bridge (#2114) — JSON on stdout.
      if (cmd === "bsc") {
        const args = (payload as { args?: string[] } | undefined)?.args ?? [];
        // #3842: ONE batched read serves every artifact — the fleet arrives as a snapshot key, not
        // its own `plan fleet get` spawn.
        if (args[1] === "snapshot") return JSON.stringify({ fleet: dbFleet });
        return ""; // any other bsc read (e.g. discovery) → empty → bscJson fallback
      }
      switch (cmd) {
        // A stray fleet.json that leaked through the sweep — must be ignored — plus a real section.
        case "read_plan_stages": return { fleet: '{"recommended":99,"streams":[]}', goal: "the goal" };
        default: return null;
      }
    });

    const { unmount } = render();

    // The fleet section reflects plan.db, never the file content.
    await waitFor(() => {
      expect(useAppStore.getState().planStages[PID]?.[FLEET_KEY]).toBe(JSON.stringify(dbFleet));
    });
    // An ordinary section file still flows through (the sweep runs; only fleet is excluded).
    expect(useAppStore.getState().planStages[PID]?.goal).toBe("the goal");
    // The batched `bsc plan snapshot` IS the fleet read path; no fleet.json file is ever read directly.
    expect(
      vi.mocked(invoke).mock.calls.some(
        ([c, p]) => c === "bsc" && (p as { args?: string[] } | undefined)?.args?.[1] === "snapshot",
      ),
    ).toBe(true);

    unmount();
  });

  it("reads plan.db in ONE batched spawn, not one per artifact (#3842)", async () => {
    // The regression this guards: the poll used to fire 17 separate `bsc plan <noun>` reads every
    // 2s, each its own process spawn at 150-660ms. That cost more than the interval, oversubscribed
    // the Tauri command queue, and stalled `pty_write` — the user could not type. #3666 stopped ticks
    // from STACKING but never shrank the tick, so the fan-out is what has to stay collapsed.
    vi.mocked(invoke).mockImplementation(async (cmd: string, payload?: unknown) => {
      if (cmd === "bsc") {
        const args = (payload as { args?: string[] } | undefined)?.args ?? [];
        if (args[1] === "snapshot") return JSON.stringify({ issues: [], features: [] });
        return "";
      }
      if (cmd === "read_plan_stages") return { goal: "g" };
      return null;
    });

    const { unmount } = render();
    await waitFor(() => {
      expect(useAppStore.getState().planStages[PID]?.goal).toBe("g");
    });

    const planReads = vi.mocked(invoke).mock.calls
      .filter(([c, p]) => c === "bsc" && (p as { args?: string[] } | undefined)?.args?.[0] === "plan")
      .map(([, p]) => ((p as { args?: string[] } | undefined)?.args ?? []).slice(0, 2).join(" "));

    // Exactly one DISTINCT plan verb, and it is the batch. Any per-noun read reappearing here means
    // the fan-out is back.
    expect([...new Set(planReads)]).toEqual(["plan snapshot"]);

    unmount();
  });
});
