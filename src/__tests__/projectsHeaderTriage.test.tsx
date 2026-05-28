import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { ProjectsHeader, type ActiveProjectInfo } from "../screens/projects/ProjectsHeader";
import { useAppStore } from "../store";

/**
 * #183: the triage button should be a one-click resume when prior state exists,
 * and a cold-start otherwise — no intervening modal. Re-triage is a separate
 * secondary action.
 */
const PROJECT: ActiveProjectInfo = {
  id: "P1",
  number: 42,
  name: "demo",
  repo: "owner/demo",
  repos: ["owner/demo"],
  description: "",
};

const RESET = {
  tabs: [{ name: "scratch", layout: "1×1", state: "idle" as const }],
  activeTabIdx: 0,
  paneCwds: {} as Record<string, string>,
  paneInitCmds: {} as Record<string, string>,
  paneStartupPromptText: {} as Record<string, string>,
  paneStartupPromptDocs: {} as Record<string, string>,
  paneCheckpointDocs: {} as Record<string, string>,
  paneContinue: {} as Record<string, boolean>,
  disabledPanes: {} as Record<string, boolean>,
  paneAllowedCommands: {} as Record<string, string[]>,
  paneNames: {} as Record<number, Record<number, string>>,
  projectLocalRepos: { P1: ["owner/demo"] } as Record<string, string[]>,
  activeScreen: "projects" as const,
};

function seedTriageTab() {
  // Mirrors what triageStartProject would leave in the store after a prior run.
  useAppStore.setState({
    ...RESET,
    tabs: [
      ...RESET.tabs,
      { name: `${PROJECT.name} · triage`, layout: "1×1", state: "idle" as const, runId: 0 },
    ],
  });
}

describe("ProjectsHeader triage / open (#183)", () => {
  beforeEach(() => { useAppStore.setState(RESET); });

  it("shows '⚡ triage' and no re-triage button when no prior triage tab exists", () => {
    const { container } = render(<ProjectsHeader project={PROJECT} />);
    const buttons = Array.from(container.querySelectorAll("button")).map(b => b.textContent ?? "");
    expect(buttons.some(t => t.includes("triage") && !t.includes("re-triage"))).toBe(true);
    expect(buttons.some(t => t.includes("re-triage"))).toBe(false);
    expect(buttons.some(t => t.includes("open"))).toBe(false);
  });

  it("shows '↗ open' + a re-triage button when a prior triage tab exists", () => {
    seedTriageTab();
    const { container } = render(<ProjectsHeader project={PROJECT} />);
    const buttons = Array.from(container.querySelectorAll("button")).map(b => b.textContent ?? "");
    expect(buttons.some(t => t.includes("open"))).toBe(true);
    expect(buttons.some(t => t.includes("re-triage"))).toBe(true);
  });

  it("clicking 'open' switches to the persisted triage tab + the console screen — no modal in the way", () => {
    seedTriageTab();
    const { container, queryByText } = render(<ProjectsHeader project={PROJECT} />);
    const openBtn = Array.from(container.querySelectorAll("button"))
      .find(b => (b.textContent ?? "").includes("open"))!;
    fireEvent.click(openBtn);
    // The persisted triage tab is index 1 in RESET-plus-tab; verify directly.
    expect(useAppStore.getState().activeTabIdx).toBe(1);
    expect(useAppStore.getState().activeScreen).toBe("console");
    // The previous flow popped a "Re-run triage?" dialog before doing anything;
    // it must not appear now — the dropped modal is the whole point of the change.
    expect(queryByText(/Re-run triage\?/)).toBeNull();
  });

  it("clicking 're-triage' rebuilds the same tab in place (runId bump, no new tab)", async () => {
    seedTriageTab();
    const tabCountBefore = useAppStore.getState().tabs.length;
    const triageIdx = 1;
    expect(useAppStore.getState().tabs[triageIdx].runId).toBe(0);

    const { container } = render(<ProjectsHeader project={PROJECT} />);
    const rerunBtn = Array.from(container.querySelectorAll("button"))
      .find(b => (b.textContent ?? "").includes("re-triage"))!;
    fireEvent.click(rerunBtn);

    // rerunTriage is async (awaits N pty_kill invocations before mutating state),
    // so wait for the post-await triageStartProject to run.
    await waitFor(() => {
      expect(useAppStore.getState().tabs[triageIdx].runId).toBe(1);
    });
    // Same tab — the in-place rebuild signal, not a new tab appended.
    expect(useAppStore.getState().tabs.length).toBe(tabCountBefore);
  });
});
