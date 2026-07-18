import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { StudioSessionMount } from "./StudioSessionMount";
import { STUDIO_INIT_CMD, STUDIO_SESSIONS } from "./lib/studioSessions";
import { buildSessionSettings } from "@/app/console/lib/sessionLaunch";
import { restrictedRoleCommands } from "@/shared/lib/session/sessionRoles";

/**
 * #3357 — the persistent studio-session mount. Before this issue each studio ran a bespoke
 * `useScreenSession` that called `ensure_session_settings` + `pty_create` itself. The mount now only
 * (a) resolves the workspace cwd and (b) SEEDS the store fields the GENERIC launch path reads, then drops
 * an off-screen `primary` TerminalSlot. So the assertions here are about the seeded launch inputs — the
 * permission payload they produce is asserted in sessionLaunch.test.ts.
 */

// The real TerminalView needs xterm/PTY; stub it with a probe that echoes the launch props the host
// sources from the primary claim (same pattern as TerminalHost.test.tsx).
vi.mock("@/app/console/panes/views/TerminalView", () => ({
  TerminalView: ({ paneId, visible, initialCwd, initCmd }: { paneId: string; visible?: boolean; initialCwd?: string; initCmd?: string }) =>
    <div data-testid="tv" data-pane={paneId} data-visible={String(!!visible)} data-cwd={initialCwd ?? ""} data-init={initCmd ?? ""} />,
}));

const DESIGN_DIR = "C:/Users/x/.base-studio-code/design-studio";
const invokeMock = vi.mocked(invoke);
const callsTo = (cmd: string) =>
  invokeMock.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args as Record<string, unknown>);

beforeEach(() => {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (cmd: string) =>
    cmd === "setup_designer_workspace" ? ({ design_dir: DESIGN_DIR } as never) : (null as never));
  useAppStore.setState({
    paneRoles: {}, paneProfiles: {}, paneStartupPromptText: {}, paneContinue: {},
    paneMcpServers: {}, paneHooks: {}, paneSkills: {}, tunnelExtraPanes: {},
  });
});
afterEach(() => cleanup());

const mountDesigner = () => render(<TerminalHost><StudioSessionMount studio="designer" /></TerminalHost>);

describe("StudioSessionMount (#3357)", () => {
  it("resolves the studio workspace, then hosts the terminal off-screen at that cwd", async () => {
    const { getByTestId } = mountDesigner();
    await waitFor(() => expect(callsTo("setup_designer_workspace")).toHaveLength(1));
    await waitFor(() => expect(getByTestId("tv")).toBeInTheDocument());

    const tv = getByTestId("tv");
    expect(tv.dataset.pane).toBe(STUDIO_SESSIONS.designer.paneId);
    expect(tv.dataset.cwd).toBe(DESIGN_DIR);
    expect(tv.dataset.init).toBe(STUDIO_INIT_CMD);
    // The holding claim is never the visible one — a dock/morph slot shows it.
    expect(tv.dataset.visible).toBe("false");
  });

  it("seeds ONLY the role (no profile) plus the kickoff/resume/extension fields the generic launch reads", async () => {
    mountDesigner();
    await waitFor(() => expect(useAppStore.getState().paneRoles[STUDIO_SESSIONS.designer.paneId]).toBe("designer"));
    const s = useAppStore.getState();
    const pid = STUDIO_SESSIONS.designer.paneId;

    // The security-critical half: a ROLE and nothing profile-shaped. `buildSessionSettings` turns the
    // role into the restricted payload; a profile would ADD auto-approved commands on top of it.
    expect(s.paneProfiles[pid]).toBeUndefined();
    expect(buildSessionSettings(useAppStore.getState(), pid).allowedCommands)
      .toEqual(restrictedRoleCommands("designer"));

    // The persona kickoff, baked into the launch arg (never typed after idle detection).
    expect(s.paneStartupPromptText[pid]).toContain("bsc ui");
    // Resume the prior conversation rather than greeting a fresh one on every re-open.
    expect(s.paneContinue[pid]).toBe(true);
    // Extensions pinned EMPTY: without these the generic path falls back to the GLOBAL sets, attaching
    // every configured MCP server (extra tools) + global skills to a session confined to one store CLI.
    expect(s.paneMcpServers[pid]).toEqual([]);
    expect(s.paneHooks[pid]).toEqual([]);
    expect(s.paneSkills[pid]).toEqual([]);
  });

  it("registers the session on the mobile roster and deregisters it on unmount (#2497)", async () => {
    const { unmount } = mountDesigner();
    await waitFor(() => expect(useAppStore.getState().tunnelExtraPanes.designer).toBeTruthy());
    expect(useAppStore.getState().tunnelExtraPanes.designer).toEqual([
      { id: STUDIO_SESSIONS.designer.paneId, cwd: DESIGN_DIR, name: "Design Studio", status: "running", kind: "designer" },
    ]);
    unmount();
    expect(useAppStore.getState().tunnelExtraPanes.designer).toBeUndefined();
  });

  it("does NOT host a terminal when the workspace setup fails — never an ungated session on an empty cwd (#1819)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "setup_designer_workspace") throw new Error("boom");
      return null as never;
    });
    const { queryByTestId } = mountDesigner();
    await waitFor(() => expect(callsTo("setup_designer_workspace")).toHaveLength(1));
    expect(queryByTestId("tv")).toBeNull();
    expect(useAppStore.getState().paneRoles[STUDIO_SESSIONS.designer.paneId]).toBeUndefined();
  });
});
