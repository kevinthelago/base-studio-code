// #1266 Stage 4 — the recovery surface: lists unrepresented sessions, restores a project, discards a
// reap-only orphan.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SessionRecoveryBanner, SandboxSetupBanner, PathExposeBanner, AppBanners } from "./AppBanners";
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
      // The fleet read now routes through the generic `bsc` bridge (#2114): `plan fleet get --full
      // --json` → JSON on stdout (the same FleetPlan the old `plan_get_fleet` command wrapped).
      if (cmd === "bsc") return JSON.stringify({ recommended: 1, reasoning: "t", streams: [], director: { enabled: true } });
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

  it("restore auto-drills Glance into the restored project AND lands on the Network tab (#2445/#3598)", async () => {
    // Start on a DIFFERENT Glance tab: the restore must FORCE Network, else the drill it sets shows nothing.
    useAppStore.setState({ glanceDrill: null, activeWorkspace: "console", activePageTab: { glance: "fleet" } });
    render(<SessionRecoveryBanner />);
    await waitFor(() => expect(screen.getByText(/2 sessions/)).toBeTruthy());
    fireEvent.click(screen.getByText("Review"));
    fireEvent.click(screen.getByText("Restore 1"));
    // The fleet restored → the user lands on Glance, on the NETWORK tab, drilled into the restored project.
    await waitFor(() => expect(useAppStore.getState().glanceDrill).toBe("proj"));
    expect(useAppStore.getState().activeWorkspace).toBe("glance");
    expect(useAppStore.getState().activePageTab.glance).toBe("network"); // #3598: not the last-active "fleet" tab
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
    useAppStore.setState({ bypassPermissions: true, sandboxNudgeDismissCount: 0 });
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

  it("counts the ✕ dismissal and then stays hidden on later launches", async () => {
    // First launch: shows. Pressing the ✕ (aria-label "Dismiss") records the dismissal…
    const first = render(<SandboxSetupBanner />);
    await screen.findByText(/Agent sandbox not set up/);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    await waitFor(() => expect(useAppStore.getState().sandboxNudgeDismissCount).toBe(1));
    first.unmount();

    // A later launch (count now at the cap): the nudge stays hidden.
    render(<SandboxSetupBanner />);
    await waitFor(() => expect(screen.queryByText(/Agent sandbox not set up/)).toBeNull());
  });

  it("stays hidden once the dismiss count has reached the cap", async () => {
    useAppStore.setState({ sandboxNudgeDismissCount: 1 });
    render(<SandboxSetupBanner />);
    await waitFor(() => expect(screen.queryByText(/Agent sandbox not set up/)).toBeNull());
  });

  it("stays hidden in the allow-list posture", async () => {
    useAppStore.setState({ bypassPermissions: false });
    render(<SandboxSetupBanner />);
    await waitFor(() => expect(screen.queryByText(/Agent sandbox not set up/)).toBeNull());
  });

});

describe("PathExposeBanner (#2734)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "path_expose_status") return { configured: false, binDir: "C:\\Apps\\bsc" };
      if (cmd === "path_expose_configure") return { changed: true, target: "your user PATH", undo: "remove it from Path" };
      return undefined;
    });
  });

  it("offers to add the bin dir, then reports what changed after configuring", async () => {
    render(<PathExposeBanner />);
    // The offer names the exact dir that would be added (transparency before the click).
    await waitFor(() => expect(screen.getByText("C:\\Apps\\bsc")).toBeTruthy());
    fireEvent.click(screen.getByText("Add to PATH"));
    // The consented write reports back where it wrote + how to undo.
    await waitFor(() => expect(screen.getByText(/Reopen your terminal/)).toBeTruthy());
    expect(screen.getByText(/remove it from Path/)).toBeTruthy();
  });

  it("stays hidden when bsc already resolves on PATH", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "path_expose_status" ? { configured: true, binDir: "C:\\Apps\\bsc" } : undefined,
    );
    render(<PathExposeBanner />);
    // Give the async status probe a tick, then assert nothing rendered.
    await waitFor(() => expect(screen.queryByText("Add to PATH")).toBeNull());
  });

  it("persists dismissal so it doesn't nag on the next launch", async () => {
    const { unmount } = render(<PathExposeBanner />);
    await waitFor(() => expect(screen.getByText("Add to PATH")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/dismiss/i));
    expect(localStorage.getItem("bsc.pathExpose.dismissed")).toBe("1");
    unmount();
    // A fresh mount reads the persisted flag and stays hidden even though detection says not-configured.
    render(<PathExposeBanner />);
    await waitFor(() => expect(screen.queryByText("Add to PATH")).toBeNull());
  });
});

describe("InterruptedLoopBanner (#3961)", () => {
  beforeEach(() => useAppStore.setState({ interruptedLoops: [] }));

  it("stays hidden when nothing was stranded", () => {
    render(<AppBanners />);
    expect(screen.queryByText(/interrupted/i)).toBeNull();
  });

  it("names the stranded loops and says why it matters", () => {
    useAppStore.setState({ interruptedLoops: [{ id: 3, a: "driver", b: "designer" }] });
    render(<AppBanners />);
    // The consequence is the point: a participant's `watch` blocks on a turn that never comes.
    expect(screen.getByText(/wait forever/i)).toBeTruthy();
    expect(screen.getByText(/driver↔designer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Close 1/ })).toBeTruthy();
  });

  it("summarises past two rather than listing every loop", () => {
    useAppStore.setState({
      interruptedLoops: [
        { id: 1, a: "a", b: "z" }, { id: 2, a: "b", b: "z" },
        { id: 3, a: "c", b: "z" }, { id: 4, a: "d", b: "z" },
      ],
    });
    render(<AppBanners />);
    expect(screen.getByText(/\+2/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Close 4/ })).toBeTruthy();
  });

  it("dismiss writes NOTHING — the loops stay open for the next boot to find", () => {
    useAppStore.setState({ interruptedLoops: [{ id: 3, a: "driver", b: "designer" }] });
    render(<AppBanners />);
    fireEvent.click(screen.getByLabelText(/dismiss/i));
    expect(useAppStore.getState().interruptedLoops).toEqual([]);
  });
});
