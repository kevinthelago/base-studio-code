import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectPane } from "../screens/projects/ProjectPane";
import type {
  ProjectPaneData, Agent, Perm, Milestone, PhaseGroup, ContextFile,
} from "../screens/projects/projectPane.types";

// ── fixtures for the real-data (hasData) path ────────────────────────────────
const PERM: Perm = {
  read: "allow", edit: "ask", create: "ask", run: "ask", net: "deny", push: "ask", pkg: "deny",
};
function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: "auth", name: "@auth", role: "worker", status: "run", repo: "o/api",
    color: "oklch(0.74 0.13 70)", initial: "A", owns: ["src/auth/**"], issues: ["#12"],
    preset: "Build", perm: { ...PERM }, flow: { autonomy: "continuous", push: "auto-PR", gate: "hard" },
    ctx: 1, ...over,
  };
}
function data(over: Partial<ProjectPaneData> = {}): ProjectPaneData {
  return {
    agents: [agent({ focus: true })],
    repos: [{ id: "o/api", branch: "main", ahead: 0, behind: 0, agents: ["auth"], primary: true, branches: [] }],
    structure: [],
    phaseStructure: [],
    context: [],
    director: { enabled: false, drive: "event" },
    ...over,
  };
}

describe("ProjectPane (v2)", () => {
  it("renders the pane header and the section shells (sample fallback)", () => {
    render(<ProjectPane />);
    expect(screen.getByText("Settlement webhooks v2")).toBeTruthy();
    expect(screen.getByText("Context Files")).toBeTruthy();
  });

  it("renders the repo-first structure (repo cards; first repo open shows its milestones)", () => {
    render(<ProjectPane />);
    fireEvent.click(screen.getByText("repo")); // repo-first is the secondary lens (#497)
    // both repository cards are present as collapsible headers
    expect(screen.getByText("acme/payments")).toBeTruthy();
    expect(screen.getByText("acme/web-dashboard")).toBeTruthy();
    // the first repo is open by default -> its milestone is visible; the second
    // repo is collapsed, so its milestone is not rendered yet
    expect(screen.getByText("Publisher MVP")).toBeTruthy();
    expect(screen.queryByText("Dashboard live-update")).toBeNull();
  });

  it("renders the agents roster with the per-agent permission editor", () => {
    render(<ProjectPane />);
    expect(screen.getByText("@planner")).toBeTruthy();
    // the framer row is open by default -> its editor shows the capability labels
    expect(screen.getByText("read files")).toBeTruthy();
    expect(screen.getAllByText("allow").length).toBeGreaterThan(0);
  });

  // ── #345: header reflects the real project, gated on hasData ────────────────
  it("shows the real project name + key when real data is present (#345)", () => {
    render(<ProjectPane data={data()} projectName="Studio Code" projectId="studio-code" />);
    expect(screen.getByText("Studio Code")).toBeTruthy();
    expect(screen.getByText("studio-code")).toBeTruthy();
    // never the sample identity when real section data is present
    expect(screen.queryByText("Settlement webhooks v2")).toBeNull();
    expect(screen.queryByText("prj_2fa")).toBeNull();
  });

  it("falls back to the sample header when there is no real data (#345)", () => {
    // Empty data (no agents/structure/context) -> hasData false -> sample identity.
    render(<ProjectPane data={data({ agents: [], repos: [] })} projectName="Studio Code" projectId="studio-code" />);
    expect(screen.getByText("Settlement webhooks v2")).toBeTruthy();
    expect(screen.queryByText("Studio Code")).toBeNull();
  });

  // ── #349: empty-milestone placeholder; one cohesive agent card ──────────────
  it("shows a placeholder for a repo with no milestones decomposed (#349)", () => {
    // A repo present but no structure for it -> the open repo card shows the
    // muted placeholder rather than an empty epic.
    render(<ProjectPane data={data({ structure: [] })} projectName="P" projectId="p" />);
    fireEvent.click(screen.getByText("repo"));
    expect(screen.getByText("no milestones decomposed yet")).toBeTruthy();
  });

  it("expands an agent into one cohesive card (no duplicate header) (#349)", () => {
    render(<ProjectPane data={data()} projectName="P" projectId="p" />);
    // The focused agent is open: its repo + owned issue appear in the expanded
    // detail meta (the "⎇ o/api" repo line is rendered only when expanded), and
    // the agent name appears exactly once — the roster row is the single header,
    // so the editor adds no second header.
    expect(screen.getByText("⎇ o/api")).toBeTruthy();
    expect(screen.getByText("#12")).toBeTruthy();
    expect(screen.getAllByText("@auth")).toHaveLength(1);
  });

  // ── #352: click a context file to open the viewer modal ─────────────────────
  it("opens a context file's content in a viewer when its row is clicked (#352)", () => {
    const context: ContextFile[] = [
      { name: "spec.md", kind: "spec", tok: "1.0k", pinned: true, scope: "project", content: "HELLO-FROM-SPEC" },
    ];
    render(<ProjectPane data={data({ context })} projectName="P" projectId="p" />);
    // The Context Files section is collapsed by default — expand it first.
    fireEvent.click(screen.getByText("Context Files"));
    // content not shown until the row is clicked
    expect(screen.queryByText("HELLO-FROM-SPEC")).toBeNull();
    fireEvent.click(screen.getByText("spec.md"));
    expect(screen.getByText("HELLO-FROM-SPEC")).toBeTruthy();
  });

  // ── #337: GitHub Structure section renders milestones -> issues + progress ───
  it("renders the GitHub Structure section with milestones, issues and progress (#337)", () => {
    const structure: Milestone[] = [
      {
        id: "o/api#M1", title: "Phase 1", repo: "o/api", pct: 0.5, state: "doing",
        epics: [{
          id: "o/api#E1", title: "Issues", pct: 0.5, issues: [
            { n: "F1", t: "Build the thing", state: "done", owner: "auth", ac: 2, branch: "F1", deps: [], sub: [] },
            { n: "F2", t: "Wire the other thing", state: "backlog", owner: "auth", ac: 1, branch: "F2", deps: ["F1"], sub: [] },
          ],
        }],
      },
    ];
    render(<ProjectPane data={data({ structure })} projectName="P" projectId="p" />);
    fireEvent.click(screen.getByText("repo"));
    expect(screen.getByText("Phase 1")).toBeTruthy();
    expect(screen.getByText("Build the thing")).toBeTruthy();
    expect(screen.getByText("Wire the other thing")).toBeTruthy();
    // per-milestone progress percentage rendered (0.5 -> 50%)
    expect(screen.getByText("50%")).toBeTruthy();
  });

  // ── #497: phase-first structure is the default view ─────────────────────────
  it("renders the phase-first structure by default — one phase spanning repos", () => {
    const phaseStructure: PhaseGroup[] = [
      {
        id: "phase-mvp", name: "MVP", doneWhen: "ships end to end", order: 0,
        closed: 1, total: 2, pct: 0.5,
        issues: [
          { n: "F1", t: "Build the thing", state: "done", owner: "auth", ac: 2, branch: "F1", deps: [], sub: [], repo: "o/api" },
          { n: "W1", t: "Wire the UI", state: "backlog", owner: "auth", ac: 1, branch: "W1", deps: ["F1"], sub: [], repo: "o/web" },
        ],
      },
    ];
    render(<ProjectPane data={data({ phaseStructure })} projectName="P" projectId="p" />);
    // phase header + "done when" + project-wide rollup, no per-repo milestone dup
    expect(screen.getByText("MVP")).toBeTruthy();
    expect(screen.getByText("ships end to end")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    // issues from BOTH repos appear under the one phase
    expect(screen.getByText("Build the thing")).toBeTruthy();
    expect(screen.getByText("Wire the UI")).toBeTruthy();
  });

  // ── #506: redundant per-section sync buttons removed ────────────────────────
  it("no longer renders the 'Sync to GitHub →' or 'Push docs →' buttons (#506)", () => {
    // Even with the label-sync affordance wired, the structure/docs publish
    // buttons are gone — publish is owned by the header button + the app's
    // Publish flow. Only 'Apply labels →' remains pane-local.
    render(
      <ProjectPane
        data={data()}
        projectName="P"
        projectId="p"
        onSyncLabels={() => {}}
        syncState={{ labels: "idle" }}
      />,
    );
    expect(screen.queryByText("Sync to GitHub →")).toBeNull();
    expect(screen.queryByText("Push docs →")).toBeNull();
    expect(screen.getByText("Apply labels →")).toBeTruthy();
  });
});
