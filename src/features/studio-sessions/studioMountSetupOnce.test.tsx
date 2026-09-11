// THE COMPONENTS PAGE OOM: a studio mount must run its workspace setup ONCE, not once per render
// (`the-studio-mount-reruns-its-setup-on-every-render`).
//
// MEASURED ON THE RUNNING APP, 2026-09-11. Three page loads each logged 52-53 `setup_designer_workspace`
// invokes, durations stepping down 3322ms → 494ms as a serialized queue, and the renderer was killed at
// 8.01 / 8.06 / 8.26 GB. `StudioSessionMount` keys its setup effect on `def`, and since the studio set is
// DERIVED rather than read from a table, `studioSessionDef` minted a new object per call. So every render
// re-ran the effect, and the effect's own writes (`seedStudioLaunchState`, `registerTunnelPanes`,
// `setLaunch`) caused the next render: a loop that never settles.
//
// The existing mount test could not see it: it waits for ONE setup call and stops looking the moment it
// sees one. This file asserts the count AFTER the mount has settled.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { StudioSessionMount } from "@/features/studio-sessions/StudioSessionMount";
import { studioSessionDef } from "@/features/studio-sessions/lib/studioSessions";

vi.mock("@/app/console/panes/views/TerminalView", () => ({
  TerminalView: ({ paneId }: { paneId: string }) => <div data-testid="tv" data-pane={paneId} />,
}));

const invokeMock = vi.mocked(invoke);
const setupCalls = () => invokeMock.mock.calls.filter(([c]) => c === "setup_designer_workspace").length;

beforeEach(() => {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (cmd: string) =>
    cmd === "setup_designer_workspace" ? ({ design_dir: "/design-studio" } as never) : (null as never));
  useAppStore.setState({
    paneRoles: {}, paneStartupPromptText: {}, paneContinue: {}, paneHooks: {}, paneSkills: {},
  });
});
afterEach(() => cleanup());

describe("a studio mount runs its setup once (the-studio-mount-reruns-its-setup-on-every-render)", () => {
  it("keeps a studio def's identity across calls, as the table it replaced did", () => {
    // Anything keyed on the def — an effect's deps, a memo — depends on this.
    expect(studioSessionDef("designerReact")).toBe(studioSessionDef("designerReact"));
    expect(studioSessionDef("librarianRust")).toBe(studioSessionDef("librarianRust"));
  });

  it("invokes setup_designer_workspace once, however often the mount re-renders", async () => {
    const { findByTestId, rerender } = render(<TerminalHost><StudioSessionMount studio="designerReact" /></TerminalHost>);
    await findByTestId("tv");                       // setup resolved and the launch state landed
    // A parent re-render is the ordinary case in the app (StudioSessionHosts re-renders on store changes).
    rerender(<TerminalHost><StudioSessionMount studio="designerReact" /></TerminalHost>);
    await new Promise((r) => setTimeout(r, 50));    // let any re-run effect resolve its invoke
    expect(setupCalls(), "the setup re-ran on re-render: the Components page OOM loop").toBe(1);
  });
});
