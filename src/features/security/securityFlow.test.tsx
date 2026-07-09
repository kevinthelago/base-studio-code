import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SecurityWorkspace } from "./";
import { useAppStore } from "@/store";

/**
 * #199 — the Agents-screen "Flow" tab surfaces the fleet's coordination state
 * (parked/ready/stalled/deadlocked sessions), cross-referenced with the profile each
 * session runs under. Coord state is rebuilt from $BSC_COORD_LOG via the mocked
 * `bsc logs tail coord` bridge read.
 */
const TS = "2026-05-30T18:00:00Z";
const mockInvoke = vi.mocked(invoke);

/** Drive invoke: `bsc logs tail coord` returns `coordLines` (as a JSON string, #2144); else null. */
function seedCoordLog(coordLines: string[]) {
  mockInvoke.mockImplementation(async (cmd: string, payload?: unknown) => {
    if (cmd === "bsc" && (payload as { args: string[] }).args?.[2] === "coord") {
      return JSON.stringify(coordLines) as unknown as null;
    }
    return null;
  });
}

/** Click the "Flow" subtab. */
function openFlow(container: HTMLElement) {
  const tab = Array.from(container.querySelectorAll(".tabstrip .tab"))
    .find((t) => (t.textContent ?? "").includes("Flow"))!;
  fireEvent.click(tab);
}

describe("Agents · Flow tab (#199)", () => {
  beforeEach(() => {
    useAppStore.setState({
      tabs: [{ name: "w", layout: "1×1", state: "idle" as const }],
      activeTabIdx: 0,
      paneProfiles: {} as Record<string, string>,
      disabledPanes: {} as Record<string, boolean>,
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
    const { container } = render(<SecurityWorkspace />);
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
    const { container, findByText } = render(<SecurityWorkspace />);
    openFlow(container);

    const wake = await findByText("Wake");
    fireEvent.click(wake);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("pty_kill", { paneId: "t0p0" });
    });
  });
});
