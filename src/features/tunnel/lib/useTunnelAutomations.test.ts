/**
 * @vitest-environment jsdom
 *
 * This file lives under `lib/`, which vitest's `node` project covers, but it genuinely needs a DOM.
 * A per-file docblock beats the project's environment, so the requirement is stated where a reader
 * meets it. See the `projects` split in vitest.config.ts for why the default is `node` here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import type { Automation } from "@/features/automations/lib/scheduler";

vi.mock("@/features/tunnel/lib/tunnelClient", () => ({
  tunnelSetAutomations: vi.fn().mockResolvedValue(undefined),
  tunnelAutomationFailed: vi.fn().mockResolvedValue(undefined),
}));

import { tunnelSetAutomations, tunnelAutomationFailed } from "@/features/tunnel/lib/tunnelClient";
import { useTunnelAutomations } from "@/features/tunnel/lib/useTunnelAutomations";

const handlers: Record<string, (e: { payload: unknown }) => void> = {};

function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: "a1", name: "Nightly", armed: false,
    when: { kind: "cron", expr: "0 2 * * *" },
    targetTab: "build", targetPaneIdx: 0,
    action: "command", command: "echo hi",
    lastRunAt: null, nextRunAt: null, runs: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(handlers)) delete handlers[k];
  vi.mocked(listen).mockImplementation((name, cb) => {
    handlers[name] = cb as (e: { payload: unknown }) => void;
    return Promise.resolve(() => {});
  });
  vi.mocked(invoke).mockResolvedValue(undefined);
  useAppStore.setState({
    automations: [auto()],
    tunnelRunning: true,
    tabs: [{ name: "build", layout: "1×1", id: "t0" }] as never,
    disabledPanes: {},
  });
});

describe("useTunnelAutomations (#937)", () => {
  it("projects the automations list to the phone when the tunnel is running", async () => {
    renderHook(() => useTunnelAutomations());
    await waitFor(() => expect(tunnelSetAutomations).toHaveBeenCalled());
    const frames = vi.mocked(tunnelSetAutomations).mock.calls[0][0];
    expect(frames).toEqual([expect.objectContaining({ id: "a1", name: "Nightly", whenExpr: "0 2 * * *" })]);
  });

  it("does not project while the tunnel is down", async () => {
    useAppStore.setState({ tunnelRunning: false });
    renderHook(() => useTunnelAutomations());
    await new Promise((r) => setTimeout(r, 0));
    expect(tunnelSetAutomations).not.toHaveBeenCalled();
  });

  it("arms an automation on a valid mobile arm request", async () => {
    renderHook(() => useTunnelAutomations());
    await waitFor(() => expect(handlers["tunnel://automation-arm"]).toBeTypeOf("function"));

    handlers["tunnel://automation-arm"]({ payload: { id: "a1", armed: true } });

    await waitFor(() => expect(useAppStore.getState().automations[0].armed).toBe(true));
    expect(tunnelAutomationFailed).not.toHaveBeenCalled();
  });

  it("rejects an invalid-cron arm back to the phone and leaves it disarmed", async () => {
    useAppStore.setState({ automations: [auto({ when: { kind: "cron", expr: "not a cron" } })] });
    renderHook(() => useTunnelAutomations());
    await waitFor(() => expect(handlers["tunnel://automation-arm"]).toBeTypeOf("function"));

    handlers["tunnel://automation-arm"]({ payload: { id: "a1", armed: true } });

    await waitFor(() =>
      expect(tunnelAutomationFailed).toHaveBeenCalledWith("a1", expect.any(Number), expect.stringMatching(/invalid cron/i), "Nightly"),
    );
    expect(useAppStore.getState().automations[0].armed).toBe(false);
  });

  it("runs a PERSONA-CARRIED schedule now, into the pane running its carrier", async () => {
    // The mobile id is `<persona>:<schedule>` — the same key the automation log uses, so a
    // phone-triggered run and a scheduled fire are indistinguishable in the history.
    useAppStore.setState({
      personas: [{ id: "p1", name: "P", blurb: "", role: "worker", startPrompt: "", skills: [],
                   schedules: [{ name: "gc", when: { kind: "cron", expr: "0 2 * * *" }, command: "echo hi" }] }] as never,
      panePersonas: { t0p0: "p1" },
      disabledPanes: {},
    });
    renderHook(() => useTunnelAutomations());
    await waitFor(() => expect(handlers["tunnel://automation-run-now"]).toBeTypeOf("function"));

    handlers["tunnel://automation-run-now"]({ payload: { id: "p1:gc" } });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("pty_write", { paneId: "t0p0", data: "echo hi\r" }));
    // The run is recorded to the LOG now, not onto a record.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("append_automation_run",
      expect.objectContaining({ schedule: "p1:gc", status: "ok" })));
  });

  it("warns rather than throwing when the phone names a schedule nobody carries", async () => {
    useAppStore.setState({ personas: [] as never });
    renderHook(() => useTunnelAutomations());
    await waitFor(() => expect(handlers["tunnel://automation-run-now"]).toBeTypeOf("function"));
    handlers["tunnel://automation-run-now"]({ payload: { id: "gone:missing" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).not.toHaveBeenCalledWith("pty_write", expect.anything());
  });
});
