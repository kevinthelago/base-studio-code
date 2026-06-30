// #1266 Stage 4 — the recovery surface: lists unrepresented sessions, restores a project, discards a
// reap-only orphan.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SessionRecoveryBanner, SandboxSetupBanner } from "./AppBanners";
import { useAppStore } from "@/store";

const DISCOVERED = [
  { paneId: "proj:auth", sources: ["worktree"], status: "dormant", projectKey: "proj", repo: "o/web", cwd: "/w" },
  { paneId: "man:t0:p1", sources: ["ledger"], status: "running", livePid: 999, projectKey: null, repo: null },
];

describe("SessionRecoveryBanner (#1266)", () => {
  let fleetStart: ReturnType<typeof vi.fn>;
  let triageStart: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "discover_sessions") return DISCOVERED;
      if (cmd === "plan_get_fleet") return { recommended: 1, reasoning: "t", streams: [], director: { enabled: true } };
      return undefined;
    });
    fleetStart = vi.fn();
    triageStart = vi.fn();
    // Empty tabs ⇒ everything discovered is unrepresented; stub the heavy launch actions.
    useAppStore.setState({ tabs: [], fleetStartProject: fleetStart as never, triageStartProject: triageStart as never });
  });

  it("surfaces the unrepresented sessions and groups them on Review", async () => {
    render(<SessionRecoveryBanner />);
    await waitFor(() => expect(screen.getByText(/2 sessions/)).toBeTruthy());
    fireEvent.click(screen.getByText("Review"));
    expect(screen.getByText("proj")).toBeTruthy();                  // the project group
    expect(screen.getByText("Manual scratch shells")).toBeTruthy(); // reap-only group
  });

  it("restores a project via the fleet launch wiring", async () => {
    render(<SessionRecoveryBanner />);
    await waitFor(() => expect(screen.getByText(/2 sessions/)).toBeTruthy());
    fireEvent.click(screen.getByText("Review"));
    fireEvent.click(screen.getByText("Restore 1"));                 // the proj group's restore
    await waitFor(() => expect(fleetStart).toHaveBeenCalledWith("proj", expect.objectContaining({ streams: [] }), "proj"));
  });

  it("the manual scratch shell is reap-only (no Restore) and Discard reaps it", async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      return cmd === "discover_sessions" ? [DISCOVERED[1]] : undefined;
    });
    render(<SessionRecoveryBanner />);
    await waitFor(() => expect(screen.getByText(/1 session/)).toBeTruthy());
    fireEvent.click(screen.getByText("Review"));
    // A reap-only group offers no Restore button…
    expect(screen.queryByText(/Restore/)).toBeNull();
    // …and Discard reaps it by pane id.
    fireEvent.click(screen.getByText("Discard"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "reap_session")).toBe(true));
    const reap = calls.find((c) => c.cmd === "reap_session");
    expect((reap!.args as { paneId: string }).paneId).toBe("man:t0:p1");
  });
});

describe("SandboxSetupBanner (#1916)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "wsl_sandbox_status"
        ? { ready: false, detail: "bubblewrap not installed", autoInstallable: true, needsWsl: false }
        : undefined,
    );
    useAppStore.setState({ bypassPermissions: true, sandboxNudgeDismissed: false });
  });

  it("nudges when the deny-list posture is on and the sandbox isn't ready", async () => {
    render(<SandboxSetupBanner />);
    await waitFor(() => expect(screen.getByText(/Agent sandbox not set up/)).toBeTruthy());
  });

  it("installs the sandbox directly from the banner", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "wsl_sandbox_status") {
        return { ready: false, detail: "bubblewrap not installed", autoInstallable: true, needsWsl: false };
      }
      if (cmd === "provision_sandbox") return "Installed bubblewrap + socat.";
      return undefined;
    });
    render(<SandboxSetupBanner />);
    const btn = await screen.findByRole("button", { name: /Install bubblewrap/ });
    fireEvent.click(btn);
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("provision_sandbox"));
  });

  it("stays hidden once dismissed", async () => {
    useAppStore.setState({ sandboxNudgeDismissed: true });
    render(<SandboxSetupBanner />);
    await waitFor(() => expect(screen.queryByText(/Agent sandbox not set up/)).toBeNull());
  });

  it("stays hidden in the allow-list posture", async () => {
    useAppStore.setState({ bypassPermissions: false });
    render(<SandboxSetupBanner />);
    await waitFor(() => expect(screen.queryByText(/Agent sandbox not set up/)).toBeNull());
  });
});
