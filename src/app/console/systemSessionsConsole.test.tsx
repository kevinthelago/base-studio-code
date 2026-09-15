// The console hosts SYSTEM sessions (`system-sessions-run-projects-and-start-when-visited`): it lists them,
// starts one only when it is opened, and a reaped one starts again on the next visit. Nothing about any of it
// is persisted — wanted/viewer state is transient and "running" is read from the PTY host.
//
// The console page and the hosts are COMPONENT RECORDS the app compiles from the store at run time, so this
// reads their committed source for what they render, and drives the real hooks and store for the behaviour.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store";
import { useStudioReaper, useSystemSessionViewer } from "@/features/studio-sessions";

const ROOT = resolve(__dirname, "../../..");
const seedSrc = (rel: string): string =>
  (JSON.parse(readFileSync(resolve(ROOT, "src-tauri/data/components/app", rel), "utf8")) as { srcText: string }).srcText;

describe("what the console renders", () => {
  const src = seedSrc("app/console/consolepage.json");

  it("lists the system sessions with their model and an observed status", () => {
    expect(src).toContain("SYSTEM_SESSIONS.map((d) =>");
    expect(src).toContain("{d.model}");
    expect(src).toContain("readPaneRuntimes(SYSTEM_SESSIONS.map((d) => d.paneId))");
    expect(src).toContain("useSystemSessionViewer(open?.id ?? null, showing)");
  });

  it("shows no project tab in the main window, and keeps each tab's hidden claim", () => {
    // A tab is visible only in a torn-off window; the main window renders the claims inside display:none.
    expect(src).toContain("const visibleTab = detached && ti === activeTabIdx;");
    expect(src).toContain('<Stack aria-hidden style={{ display: "none" }}>{tabSlots}</Stack>');
    expect(src).not.toMatch(/visible=\{isActiveTab\}/);
  });

  it("the hosts launch every wanted system session through one path", () => {
    const hosts = seedSrc("features/studio-sessions/studiosessionhosts.json");
    expect(hosts).toContain('["session", "prepare", def.id, "--context", "-", "--json"]');
    expect(hosts).toContain("systemSessions.map((id) => <SystemSessionMount key={id} id={id} />)");
  });
});

/** The console's two lifecycle calls, without the page: a viewer of `open` while `showing`, and the reaper. */
function Harness({ open, showing }: { open: string | null; showing: boolean }) {
  useStudioReaper();
  useSystemSessionViewer(open, showing);
  return null;
}

describe("lazy start, reap, restart on revisit", () => {
  let reaped: ((e: { payload: string }) => void) | undefined;
  beforeEach(() => {
    reaped = undefined;
    vi.mocked(listen).mockImplementation((async (name: string, cb: (e: { payload: string }) => void) => {
      if (name === "pty-reaped") reaped = cb;
      return () => {};
    }) as unknown as typeof listen);
    useAppStore.setState({ wantedSystemSessions: [], wantedStudios: [], studioViewers: {} });
  });

  it("nothing is wanted until a session is opened, then only that one", () => {
    const view = render(<Harness open={null} showing />);
    expect(useAppStore.getState().wantedSystemSessions).toEqual([]);
    view.rerender(<Harness open="tutor-local" showing />);
    expect(useAppStore.getState().wantedSystemSessions).toEqual(["tutor-local"]);
    expect(useAppStore.getState().studioViewers["tutor-local"]).toBe(1);
    view.unmount();
  });

  it("a reaped session leaves the wanted list and the next visit starts it again", () => {
    const view = render(<Harness open="tutor-claude" showing />);
    // Leave the console: the viewer goes, the session stays wanted until the backend reaps it.
    view.rerender(<Harness open="tutor-claude" showing={false} />);
    expect(useAppStore.getState().studioViewers["tutor-claude"]).toBe(0);
    expect(useAppStore.getState().wantedSystemSessions).toEqual(["tutor-claude"]);
    expect(reaped).toBeTruthy();
    act(() => { reaped!({ payload: "system-session:tutor-claude" }); });
    expect(useAppStore.getState().wantedSystemSessions).toEqual([]);
    // Revisit.
    view.rerender(<Harness open="tutor-claude" showing />);
    expect(useAppStore.getState().wantedSystemSessions).toEqual(["tutor-claude"]);
    view.unmount();
  });

  it("a reap of a studio pane leaves the system sessions alone", () => {
    const view = render(<Harness open="tutor-local" showing={false} />);
    act(() => { useAppStore.getState().openSystemSession("tutor-local"); });
    act(() => { reaped!({ payload: "teams-studio:architect" }); });
    expect(useAppStore.getState().wantedSystemSessions).toEqual(["tutor-local"]);
    view.unmount();
  });
});
