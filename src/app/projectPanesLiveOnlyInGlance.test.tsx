// A project's panes live ONLY in Glance (`project-fleet-panes-live-only-in-glance`).
//
// A director, a worker, a triage pane and a project debug pane used to be mounted through the console: every
// persisted console tab kept a hidden `primary` claim for its cells, triage launched only because such a claim
// existed, and a torn-off window could pin one of those tabs. The console now hosts system sessions alone.
// Every project pane is started by giving it a LAUNCH GENERATION, which `TerminalHost` holds and mounts whether
// or not a surface shows it, and Glance is where it is shown.
//
// Two kinds of assertion, because two kinds of regression are possible. The behavioural ones drive the real
// store through the paths a launch takes — `bsc fleet start` and the director bridge both call
// `fleetStartProject`, `bsc fleet wake` calls `wakePane` — and check the pane is held by the host and no tab is
// written. The source ones are the GUARD: they fail against the old hidden-tabs console, because that is the
// shape most likely to come back quietly (a claim loop is a few lines, and everything still "works").
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useAppStore } from "@/store";
import { heldPaneIds } from "@/app/console/terminal/TerminalHost";
import { directorPaneId, fleetPaneId, triagePaneId } from "@/app/console/lib/paneIdentity";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";
import appSource from "@/app/App.tsx?raw";
import detachedSource from "@/app/DetachedWindow.tsx?raw";
import terminalHostSource from "@/app/console/terminal/TerminalHost.tsx?raw";
// A record, emitted as `.tsx` (`bsc graph impl get projects.ts`).
import projectsSource from "@/store/slices/projects.tsx?raw";

const ROOT = resolve(__dirname, "../..");
const consolePageSrc = (): string =>
  (JSON.parse(readFileSync(resolve(ROOT, "src-tauri/data/components/app/app/console/consolepage.json"), "utf8")) as {
    srcText: string;
  }).srcText;

const FLEET: FleetPlan = {
  recommended: 1,
  reasoning: "",
  director: { enabled: true },
  streams: [{ id: "api", name: "API", repo: "own/api", owns: [], issues: [], dependsOn: [] }],
};

/** What `TerminalHost` would hold — and therefore mount — for the store as it is now. */
const held = (): Set<string> => {
  const s = useAppStore.getState();
  return new Set(heldPaneIds(s.paneLaunchGen, s));
};

beforeEach(() => {
  useAppStore.setState({
    tabs: [], activeTabIdx: 0,
    paneLaunchGen: {}, paneCwds: {}, fleetPaneStreams: {},
    endedPanes: {}, disabledPanes: {}, dormantPanes: {},
    bscBaseDir: "/base", activeWorkspace: "glance",
  });
});

describe("a launched project pane mounts through the host and Glance, not the console", () => {
  it("bsc fleet start: the director and every worker are held by the host, and no console tab is written", () => {
    useAppStore.getState().fleetStartProject("Proj", FLEET, "proj");
    const s = useAppStore.getState();
    // The director, the feature worker, and the repo's commons + integration lanes, which are ordinary streams.
    expect(held()).toEqual(new Set([
      directorPaneId("proj"), fleetPaneId("proj", "api"), fleetPaneId("proj", "commons"), fleetPaneId("proj", "integration"),
    ]));
    expect(s.tabs).toEqual([]);
    expect(s.activeWorkspace).toBe("glance");
  });

  it("bsc fleet wake: a wake starts the pane again through the host, still with no tab", () => {
    useAppStore.getState().fleetStartProject("Proj", FLEET, "proj");
    const worker = fleetPaneId("proj", "api");
    useAppStore.getState().reapPane(worker);
    expect(held().has(worker)).toBe(false);

    expect(useAppStore.getState().wakePane(worker, "pick it back up")).toBe(true);
    expect(held().has(worker)).toBe(true);
    expect(useAppStore.getState().paneLaunchGen[worker]).toBe(2);
    expect(useAppStore.getState().tabs).toEqual([]);
  });

  it("triage: each repo pane is held by the host — the path that used to launch only through a tab claim", () => {
    useAppStore.getState().triageStartProject("proj", ["o/web", "o/api"], "proj");
    expect(held()).toEqual(new Set([triagePaneId("proj", "o/web"), triagePaneId("proj", "o/api")]));
    expect(useAppStore.getState().tabs).toEqual([]);
  });

  it("nothing restores what was running: an unlaunched store holds no project pane", () => {
    // A persisted-looking store with wiring and no launch generation — the state after a restart.
    useAppStore.setState({ paneCwds: { [directorPaneId("proj")]: "/base/projects/proj" }, paneLaunchGen: {} });
    expect(held().size).toBe(0);
  });
});

describe("the console renders only system sessions", () => {
  it("its one terminal slot is the open system session", () => {
    const src = consolePageSrc();
    expect(src).toContain("SYSTEM_SESSIONS.map((d) =>");
    expect(src.match(/<TerminalSlot\b/g)).toHaveLength(1);
    expect(src).toContain("<TerminalSlot paneId={open.paneId}");
  });
});

describe("GUARD: nothing reads the console tabs to mount a pane", () => {
  it("the console page keeps no claim per tab and takes no tab override", () => {
    const src = consolePageSrc();
    expect(src, "the hidden per-tab claims are back").not.toContain("tabSlots");
    expect(src).not.toMatch(/useAppStore\(\(s\) => s\.tabs\)/);
    // A `primary` PROP on a slot is the launch claim; the word in a comment is not.
    expect(src).not.toMatch(/<TerminalSlot[^>]*\bprimary\b/);
    expect(src).not.toContain("tabIdxOverride");
    expect(src).not.toContain("paneIdFor");
  });

  it("the shell mounts no console tab machinery, and no window pins a console tab", () => {
    expect(appSource).not.toContain("useConsoleTabs");
    expect(appSource).not.toMatch(/s\.tabs\b/);
    expect(detachedSource).not.toContain("tabIdxOverride");
    expect(detachedSource).not.toMatch(/s\.tabs\b/);
  });

  it("the host holds panes by launch generation, never by tab", () => {
    expect(terminalHostSource).toContain("heldPaneIds(launchGen");
    expect(terminalHostSource).not.toMatch(/\.tabs\b/);
  });

  it("no launch path writes or looks up a console tab", () => {
    expect(projectsSource).not.toMatch(/\btabs:/);
    expect(projectsSource).not.toContain("findProjectTabIdx");
    expect(projectsSource).not.toContain("findPaneOwnerTab");
    expect(projectsSource).not.toContain("activeTabIdx");
  });
});
