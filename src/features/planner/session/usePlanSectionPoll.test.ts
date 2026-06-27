// #1805: plan.db is the SOLE fleet store — usePlanSectionPoll must never read a fleet.json file.
// These tests pin that the fleet section is sourced from plan.db (`plan_get_fleet`) and that a
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
    usePlanSectionPoll({ visible: true, projectId: PID, publishRepos: [], enqueueMcpDownloads: () => {} }),
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
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "plan_get_fleet": return dbFleet;
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
    // plan_get_fleet IS the fleet read path; no fleet.json file is ever read directly.
    expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "plan_get_fleet")).toBe(true);

    unmount();
  });
});
