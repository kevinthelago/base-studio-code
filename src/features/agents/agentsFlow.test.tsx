import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { AgentsWorkspace } from "./";
import { useAppStore } from "@/store";
import { startRun } from "@/shared/lib/fleet/conductor";
import { WORKFLOW_PRESETS } from "@/shared/lib/fleet/workflow";

/**
 * #199/#220 — the Agents-screen "Flow" tab surfaces the fleet's coordination + workflow
 * state (parked/ready/stalled/deadlocked sessions, workflow lanes), cross-referenced with
 * the profile each session runs under. Coord state is rebuilt from $BSC_COORD_LOG via the
 * mocked read_coord_log; workflow runs come from the store.
 */
const TS = "2026-05-30T18:00:00Z";
const mockInvoke = vi.mocked(invoke);

/** Drive invoke per-command: read_coord_log returns `coordLines`, everything else null. */
function seedCoordLog(coordLines: string[]) {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "read_coord_log") return coordLines as unknown as null;
    return null;
  });
}

/** Click the "Flow" subtab. */
function openFlow(container: HTMLElement) {
  const tab = Array.from(container.querySelectorAll(".tabstrip .tab"))
    .find((t) => (t.textContent ?? "").includes("Flow"))!;
  fireEvent.click(tab);
}

describe("Agents · Flow tab (#199/#220)", () => {
  beforeEach(() => {
    useAppStore.setState({
      tabs: [{ name: "w", layout: "1×1", state: "idle" as const }],
      activeTabIdx: 0,
      paneProfiles: {} as Record<string, string>,
      disabledPanes: {} as Record<string, boolean>,
      workflowRuns: {},
    });
  });
  afterEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(null);
  });

  it("flags a mutual A↔B wait-for cycle as a deadlock and shows the escalation banner", async () => {
    seedCoordLog([
      `${TS}\tt0p0\tblocked\tsession:t0p1`,
      `${TS}\tt0p1\tblocked\tsession:t0p0`,
    ]);
    const { container } = render(<AgentsWorkspace />);
    openFlow(container);

    await waitFor(() => {
      expect(container.textContent).toContain("⚠ deadlock");
    });
    // Both sessions render a "deadlocked" chip.
    const tags = Array.from(container.querySelectorAll(".chip")).map((t) => t.textContent ?? "");
    expect(tags.filter((t) => t.includes("deadlocked")).length).toBe(2);
  });

  it("shows a Wake button for a ready waiter and actuates it (pty_kill) on click", async () => {
    seedCoordLog([
      `${TS}\tt0p0\tblocked\t#1`,
      `${TS}\tx\tmerged\t#1`, // #1 lands -> t0p0 is ready
    ]);
    const { container, findByText } = render(<AgentsWorkspace />);
    openFlow(container);

    const wake = await findByText("Wake");
    fireEvent.click(wake);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("pty_kill", { paneId: "t0p0" });
    });
  });

  it("renders workflow lanes with their stage sequence", async () => {
    const presetKey = Object.keys(WORKFLOW_PRESETS)[0];
    const run = startRun(WORKFLOW_PRESETS[presetKey], "#42").run;
    useAppStore.setState({ workflowRuns: { "#42": run } });
    seedCoordLog([]);

    const { container } = render(<AgentsWorkspace />);
    openFlow(container);

    await waitFor(() => {
      const section = container.querySelector(".body")!;
      expect(within(section as HTMLElement).getByText("#42")).toBeInTheDocument();
    });
    // The first preset stage name appears as a chip.
    const firstStage = Object.values(run.workflow.stages)[0].name;
    expect(container.textContent).toContain(firstStage);
  });
});
