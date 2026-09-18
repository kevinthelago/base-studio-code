// The console hosts one RUN session per network (`the-console-hosts-one-run-session-per-network`): it lists every
// network, starts a network's run session — its steward, `network-<slug>:steward` — only when it is opened, and a
// session nobody is viewing is reaped and starts again on the next visit. Nothing about any of it is persisted —
// wanted/viewer state is transient and "running" is read from the PTY host.
//
// The console page and the hosts are COMPONENT RECORDS the app compiles from the store at run time, so this
// reads their committed source for what they render, and drives the real hooks and store for the behaviour.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store";
import { useStudioReaper, useSystemSessionViewer, useRunSessionViewer } from "@/features/studio-sessions";

const ROOT = resolve(__dirname, "../../..");
const seedSrc = (rel: string): string =>
  (JSON.parse(readFileSync(resolve(ROOT, "src-tauri/data/components/app", rel), "utf8")) as { srcText: string }).srcText;

describe("what the console renders", () => {
  const src = seedSrc("app/console/consolepage.json");

  it("lists every network's run session, with an observed status, and nothing else", () => {
    expect(src).toContain("useAppStore((s) => s.networks)");
    expect(src).toContain("networks.map((n) =>");
    expect(src).toContain("readPaneRuntimes(ids.map(networkStewardPaneId))");
    expect(src).toContain("useRunSessionViewer(open?.id ?? null, showing)");
    // The tutors are no longer listed here: each network's run session is the console's whole content.
    expect(src).not.toContain("SYSTEM_SESSIONS");
    expect(src).not.toContain("useSystemSessionViewer");
  });

  it("its page tabs ARE the networks, and the active tab is the one run session it shows", () => {
    // The maintainer's shape: one tab per network, one session per tab — the same Screen tab strip every
    // workspace uses, with the active tab remembered like any page's (`activePageTab.console`).
    expect(src).toContain('usePageTabs("console", consoleTabs)');
    expect(src).toContain("<Screen tabs={tabs} active={activeId}");
    expect(src).toContain("networks.find((n) => n.id === activeId)");
    // No second way to pick a session beside the tabs.
    expect(src).not.toContain("<Button");
  });

  it("hosts one slot — the open run session, only while it is wanted — and no project tab or hidden claim", () => {
    // `project-fleet-panes-live-only-in-glance`: a project's panes live in Glance, so the console keeps no
    // hidden `primary` claim per tab and pins no torn-off tab.
    expect(src).not.toContain("tabSlots");
    expect(src).not.toMatch(/s\.tabs\b/);
    expect(src).not.toContain("tabIdxOverride");
    expect(src).not.toMatch(/<TerminalSlot[^>]*\bprimary\b/);
    expect(src.match(/<TerminalSlot\b/g)).toHaveLength(1);
    expect(src).toContain("<TerminalSlot paneId={networkStewardPaneId(open.id)}");
    // A slot left over a REAPED session would keep its dead terminal claimed, so reopening would reattach to
    // nothing instead of launching.
    expect(src).toContain("s.wantedRunSessions.includes(open.id)");
    expect(src).toContain("open && openWanted ?");
  });

  it("the hosts prepare every wanted run session with the SAME verb a person runs in a terminal", () => {
    // `a-run-session-directory-carries-its-isolation`: one writer for the directory the app launches in and the one
    // a person starts by hand — `bsc session prepare <pane>` writes the charter, the live capability context and
    // the bsc-agent permission document. The mount no longer writes a workspace of its own.
    const hosts = seedSrc("features/studio-sessions/studiosessionhosts.json");
    expect(hosts).toContain("runSessions.map((id) => <RunSessionMount key={id} networkId={id} />)");
    expect(hosts).toContain('["session", "prepare", paneId, "--context", "-", "--json"]');
    expect(hosts).not.toContain("setup_network_steward_workspace");
    // …and the pane EXECs into the sandbox, so no host shell — where `bsc` is the whole CLI — is left behind it
    // (`a-run-session-pane-never-leaves-its-sandbox`). Mirrors `run_cage::pane_launch_line`.
    expect(hosts).toContain('initCmd={`exec "$BSC_BIN" session enter ${paneId}`}');
    expect(hosts).toMatch(/<TerminalSlot paneId=\{paneId\} primary parked visible=\{false\}/);
  });
});

/** The console's lifecycle calls, without the page: a viewer of the open network while `showing`, and the reaper. */
function RunHarness({ open, showing }: { open: string | null; showing: boolean }) {
  useStudioReaper();
  useRunSessionViewer(open, showing);
  return null;
}

/** The same for a system session, whose mechanism the run sessions share. */
function SystemHarness({ open, showing }: { open: string | null; showing: boolean }) {
  useStudioReaper();
  useSystemSessionViewer(open, showing);
  return null;
}

let reaped: ((e: { payload: string }) => void) | undefined;
beforeEach(() => {
  reaped = undefined;
  vi.mocked(listen).mockImplementation((async (name: string, cb: (e: { payload: string }) => void) => {
    if (name === "pty-reaped") reaped = cb;
    return () => {};
  }) as unknown as typeof listen);
  useAppStore.setState({
    wantedSystemSessions: [], wantedStudios: [], wantedRunSessions: [], wantedNetworkArchitects: [], studioViewers: {},
  });
});

describe("a network's run session: lazy start, reaped when not focused, restart on revisit", () => {
  it("nothing is wanted until a network is opened, then only its run session, viewed under its pane id", () => {
    const view = render(<RunHarness open={null} showing />);
    expect(useAppStore.getState().wantedRunSessions).toEqual([]);
    view.rerender(<RunHarness open="network-finance" showing />);
    expect(useAppStore.getState().wantedRunSessions).toEqual(["network-finance"]);
    expect(useAppStore.getState().studioViewers["network-finance:steward"]).toBe(1);
    // The network's ARCHITECT is a different session and is not started by opening its run session.
    expect(useAppStore.getState().wantedNetworkArchitects).toEqual([]);
    view.unmount();
  });

  it("moving to another network unfocuses the first: its viewer goes, so the reaper may take it", () => {
    const view = render(<RunHarness open="network-finance" showing />);
    view.rerender(<RunHarness open="network-kitchen" showing />);
    const st = useAppStore.getState();
    expect(st.studioViewers["network-finance:steward"]).toBe(0);
    expect(st.studioViewers["network-kitchen:steward"]).toBe(1);
    expect(st.wantedRunSessions).toEqual(["network-finance", "network-kitchen"]);
    // The backend reaps the unfocused one once it is quiet; the renderer drops it.
    act(() => { reaped!({ payload: "network-finance:steward" }); });
    expect(useAppStore.getState().wantedRunSessions).toEqual(["network-kitchen"]);
    view.unmount();
  });

  it("a reaped run session leaves the wanted list and the next visit starts it again", () => {
    const view = render(<RunHarness open="network-finance" showing />);
    view.rerender(<RunHarness open="network-finance" showing={false} />);
    expect(useAppStore.getState().studioViewers["network-finance:steward"]).toBe(0);
    expect(useAppStore.getState().wantedRunSessions).toEqual(["network-finance"]);
    act(() => { reaped!({ payload: "network-finance:steward" }); });
    expect(useAppStore.getState().wantedRunSessions).toEqual([]);
    view.rerender(<RunHarness open="network-finance" showing />);
    expect(useAppStore.getState().wantedRunSessions).toEqual(["network-finance"]);
    view.unmount();
  });

  it("a reaped ARCHITECT leaves the wanted list too, so the next ask wakes it instead of finding it 'running'", () => {
    const view = render(<RunHarness open="network-finance" showing />);
    act(() => { useAppStore.getState().openNetworkArchitect("network-finance"); });
    act(() => { reaped!({ payload: "network-finance:architect" }); });
    const st = useAppStore.getState();
    expect(st.wantedNetworkArchitects).toEqual([]);
    // …and a reap of the architect is not a reap of the network's run session.
    expect(st.wantedRunSessions).toEqual(["network-finance"]);
    view.unmount();
  });
});

describe("a system session: the mechanism run sessions share", () => {
  it("a reaped session leaves the wanted list and the next visit starts it again", () => {
    const view = render(<SystemHarness open="tutor-claude" showing />);
    view.rerender(<SystemHarness open="tutor-claude" showing={false} />);
    expect(useAppStore.getState().studioViewers["tutor-claude"]).toBe(0);
    act(() => { reaped!({ payload: "system-session:tutor-claude" }); });
    expect(useAppStore.getState().wantedSystemSessions).toEqual([]);
    view.rerender(<SystemHarness open="tutor-claude" showing />);
    expect(useAppStore.getState().wantedSystemSessions).toEqual(["tutor-claude"]);
    view.unmount();
  });

  it("a reap of a studio pane leaves the system and run sessions alone", () => {
    const view = render(<SystemHarness open="tutor-local" showing={false} />);
    act(() => {
      useAppStore.getState().openSystemSession("tutor-local");
      useAppStore.getState().openRunSession("network-finance");
    });
    act(() => { reaped!({ payload: "teams-studio:architect" }); });
    expect(useAppStore.getState().wantedSystemSessions).toEqual(["tutor-local"]);
    expect(useAppStore.getState().wantedRunSessions).toEqual(["network-finance"]);
    view.unmount();
  });
});
