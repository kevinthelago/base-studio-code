// #1805: plan.db is the SOLE fleet store — usePlanSectionPoll must never read a fleet.json file.
// These tests pin that the fleet section is sourced from plan.db (`bsc plan fleet get`) and that a
// `fleet` key leaking out of `read_plan_sections` (a stray on-disk file) is ignored, while ordinary
// section files still flow through.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { usePlanSectionPoll } from "./usePlanSectionPoll";
import { FLEET_KEY } from "../fleet/planFleet";

const PID = "p-fleet-poll";

const render = () =>
  renderHook(() =>
    usePlanSectionPoll({ visible: true, projectId: PID, publishRepos: [], enqueueMcpDownloads: () => {}, planningDir: "" }),
  );

describe("usePlanSectionPoll — fleet is plan.db-only (#1805)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ planSections: {}, planConfirmedSections: {} });
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
        if (args[1] === "fleet") return JSON.stringify(dbFleet); // `plan fleet get --full --json`
        return ""; // other bsc reads (issues/features/…) → empty → bscJson fallback
      }
      switch (cmd) {
        // A stray fleet.json that leaked through the sweep — must be ignored — plus a real section.
        case "read_plan_sections": return { fleet: '{"recommended":99,"streams":[]}', goal: "the goal" };
        default: return null;
      }
    });

    const { unmount } = render();

    // The fleet section reflects plan.db, never the file content.
    await waitFor(() => {
      expect(useAppStore.getState().planSections[PID]?.[FLEET_KEY]).toBe(JSON.stringify(dbFleet));
    });
    // An ordinary section file still flows through (the sweep runs; only fleet is excluded).
    expect(useAppStore.getState().planSections[PID]?.goal).toBe("the goal");
    // `bsc plan fleet get --full --json` IS the fleet read path; no fleet.json file is ever read directly.
    expect(
      vi.mocked(invoke).mock.calls.some(
        ([c, p]) => c === "bsc" && (p as { args?: string[] } | undefined)?.args?.[1] === "fleet",
      ),
    ).toBe(true);

    unmount();
  });
});
