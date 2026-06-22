import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectPane } from "./ProjectPane";
import type { Phase } from "../stages/focusedPlan";

const ph = (key: string, name: string, status: Phase["status"], index: number, total: number): Phase =>
  ({ key, name, glyph: "•", blurb: `${name} blurb`, gate: "gate", index, total, status, fraction: 0 });

const baseFocus = (over: Partial<Parameters<typeof ProjectPane>[0]["focus"] & object> = {}) => ({
  phases: [ph("context", "Context", "active", 0, 3), ph("structure", "Structure", "upcoming", 1, 3), ph("permissions", "Permissions", "locked", 2, 3)],
  selectedIdx: 0,
  activeIdx: 0,
  onSelect: vi.fn(),
  pill: "wait" as const,
  footer: { kind: "approve-continue" as const, enabled: false },
  onBack: vi.fn(),
  onPrimary: vi.fn(),
  ...over,
});

describe("ProjectPane focused mode (#652)", () => {
  it("renders the stepper + the selected phase, and selects on step click", () => {
    const onSelect = vi.fn();
    render(<ProjectPane focus={baseFocus({ onSelect })} />);
    expect(screen.getByText("PHASE 01 / 03")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Context" })).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Permissions"));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("shows a lock banner when browsing a future phase", () => {
    render(<ProjectPane focus={baseFocus({ selectedIdx: 2, activeIdx: 0 })} />);
    expect(screen.getByText(/Locked\./)).toBeInTheDocument();
    expect(screen.getByText("PHASE 03 / 03")).toBeInTheDocument();
  });

  it("renders the file-drop intake surface for the UI stage (#829)", () => {
    render(<ProjectPane projectId="proj-x" focus={baseFocus({
      phases: [ph("ui", "UI", "active", 0, 1)],
      selectedIdx: 0, activeIdx: 0,
    })} />);
    expect(screen.getByText(/Drop design files or a folder/i)).toBeInTheDocument();
  });

  it("renders a generic body for a section without a dedicated panel", () => {
    render(<ProjectPane focus={baseFocus({
      phases: [ph("testing", "Testing", "active", 0, 1)],
      selectedIdx: 0, activeIdx: 0,
    })} />);
    expect(screen.getByText(/planner documents this stage/)).toBeInTheDocument();
  });

  it("opens a context file's markdown in the viewer when its row is clicked", () => {
    const data = {
      agents: [], repos: [], structure: [], phaseStructure: [], issues: [],
      context: [{ name: "goal.md", kind: "doc", tok: "1.2k", pinned: false, scope: "project", content: "# Goal\n\nThe one outcome." }],
    } as unknown as Parameters<typeof ProjectPane>[0]["data"];
    render(<ProjectPane data={data} focus={baseFocus()} />); // context phase active
    // the file is listed, but its content isn't shown until opened
    expect(screen.getByText("goal.md")).toBeInTheDocument();
    expect(screen.queryByText(/The one outcome\./)).not.toBeInTheDocument();
    // clicking the row opens the viewer with the markdown content (#…)
    fireEvent.click(screen.getByText("goal.md"));
    expect(screen.getByText(/The one outcome\./)).toBeInTheDocument();
  });

  it("names each required context file as written or missing (#1061)", () => {
    const data = {
      agents: [], repos: [], structure: [], phaseStructure: [], issues: [],
      context: [{ name: "goal.md", kind: "doc", tok: "1.2k", pinned: false, scope: "project", content: "# Goal" }],
    } as unknown as Parameters<typeof ProjectPane>[0]["data"];
    // goal.md is written; scope/users are required-but-missing.
    render(<ProjectPane data={data} focus={baseFocus({ requiredContext: ["goal", "scope", "users"] })} />);
    // every required topic is named by its file, including the ones not yet written
    expect(screen.getByText("scope.md")).toBeInTheDocument();
    expect(screen.getByText("users.md")).toBeInTheDocument();
    // exactly the two unwritten ones are flagged "missing"
    expect(screen.getAllByText("missing")).toHaveLength(2);
    // and the written/total counter reflects 1 of 3
    expect(screen.getByText("1/3 written")).toBeInTheDocument();
  });

  // #674 — the focused planner shows REAL data (empty states), never the sample mocks.
  const reposPhase = { phases: [ph("repos", "Repos", "active", 0, 1)], selectedIdx: 0, activeIdx: 0 };

  it("lists the linked repositories with tiles, metadata, and stateful branch chips (#811)", () => {
    const data = { agents: [], repos: [
      { id: "acme/web", branch: "main", ahead: 2, behind: 1, agents: [], primary: true, cloned: true,
        lang: "TypeScript", desc: "Operator dashboard",
        branches: [{ n: "stream-ui", issue: 12, state: "draft", ahead: 0, behind: 0 }] },
    ], structure: [], phaseStructure: [], context: [], issues: [] } as unknown as Parameters<typeof ProjectPane>[0]["data"];
    render(<ProjectPane data={data} focus={baseFocus(reposPhase)} />);
    expect(screen.getByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText("primary")).toBeInTheDocument();
    expect(screen.getByText("● cloned")).toBeInTheDocument();        // clone status
    expect(screen.getByText("repositories")).toBeInTheDocument();     // tile
    expect(screen.getByText("TypeScript")).toBeInTheDocument();       // language chip (#811)
    expect(screen.getByText("Operator dashboard")).toBeInTheDocument(); // description (#811)
    expect(screen.getByText("↑2")).toBeInTheDocument();              // ahead count (#811)
    expect(screen.getByText("↓1")).toBeInTheDocument();              // behind count (#811)
    expect(screen.getByText(/stream-ui/)).toBeInTheDocument();        // planned branch chip
    expect(screen.getByText(/#12/)).toBeInTheDocument();             // branch issue number (#811)
  });

  it("shows an empty state (no mock repos) when none are linked", () => {
    render(<ProjectPane focus={baseFocus(reposPhase)} />);
    expect(screen.getByText(/No repositories linked yet/)).toBeInTheDocument();
  });

  it("lets the user manually link a repository via the dropzone (#677 / #811)", () => {
    const onLinkRepo = vi.fn();
    render(<ProjectPane focus={baseFocus(reposPhase)} onLinkRepo={onLinkRepo} />);
    // The input is behind a dashed dropzone now — click to reveal it.
    fireEvent.click(screen.getByText(/link another repository/));
    const input = screen.getByLabelText("Link a repository");
    fireEvent.change(input, { target: { value: "not-a-repo" } });
    fireEvent.click(screen.getByText("link"));
    expect(onLinkRepo).not.toHaveBeenCalled(); // invalid (no owner/repo) — button is disabled
    fireEvent.change(input, { target: { value: "acme/web" } });
    fireEvent.click(screen.getByText("link"));
    expect(onLinkRepo).toHaveBeenCalledWith("acme/web");
  });

  it("shows an empty context state (no mock files) on a fresh plan", () => {
    render(<ProjectPane focus={baseFocus()} />); // context phase active, no data
    expect(screen.getByText(/No context files yet/)).toBeInTheDocument();
  });

  it("shows empty states (no mock structure/agents) for a fresh Plan + permissions stage", () => {
    const { rerender } = render(<ProjectPane focus={baseFocus({
      phases: [ph("structure", "Plan", "active", 0, 1)], selectedIdx: 0, activeIdx: 0,
    })} />);
    expect(screen.getByText(/No plan yet/)).toBeInTheDocument();
    rerender(<ProjectPane focus={baseFocus({
      phases: [ph("permissions", "Permissions", "active", 0, 1)], selectedIdx: 0, activeIdx: 0,
    })} />);
    expect(screen.getByText(/No fleet yet/)).toBeInTheDocument();
  });

  it("renders the Permissions fleet as agent rows + a generate-profiles action (#817)", () => {
    const onGenerateProfiles = vi.fn();
    const permsPhase = { phases: [ph("permissions", "Permissions", "active", 0, 1)], selectedIdx: 0, activeIdx: 0 };
    const data = { agents: [
      { id: "auth", name: "@auth", role: "worker", status: "idle", repo: "acme/api", color: "#888",
        initial: "A", owns: ["src/auth/**"], issues: [], preset: "Build",
        perm: { read: "allow", edit: "allow", create: "allow", run: "ask", net: "deny", push: "ask", pkg: "deny" },
        flow: { autonomy: "checkpoint", push: "auto-PR", gate: "soft" }, ctx: 1 },
    ], repos: [], structure: [], phaseStructure: [], context: [], issues: [] } as unknown as Parameters<typeof ProjectPane>[0]["data"];
    render(<ProjectPane data={data} focus={baseFocus(permsPhase)} onGenerateProfiles={onGenerateProfiles} />);
    // the stream renders as an agent row (no more "No agents yet" stub)
    expect(screen.getByText("@auth")).toBeInTheDocument();
    // and the generate-profiles action drives the gate-completing step
    fireEvent.click(screen.getByText("Generate least-privilege profiles"));
    expect(onGenerateProfiles).toHaveBeenCalled();
  });

  it("renders the Plan review (phases + seam graph) with no in-body approve button (#949)", () => {
    // The Structure stage's only approve control is the footer's "approve & continue" — the
    // duplicate in-body "Approve milestones & seams" button was removed (#949).
    const data = { agents: [], repos: [], structure: [], context: [], issues: [],
      phaseStructure: [{ id: "p1", name: "Phase 1 — MVP", total: 3, issues: [], closed: 0, pct: 0, order: 0, doneWhen: "" }],
      seamGraph: { nodes: [], edges: [], layerCount: 0, danglingCount: 0 },
    } as unknown as Parameters<typeof ProjectPane>[0]["data"];
    render(<ProjectPane data={data} focus={baseFocus({
      phases: [ph("structure", "Plan", "active", 0, 1)], selectedIdx: 0, activeIdx: 0,
    })} />);
    expect(screen.getByText("Phase 1 — MVP")).toBeInTheDocument();
    expect(screen.queryByText(/Approve milestones/)).not.toBeInTheDocument();
  });

  it("renders the automations + skills bodies from real data, with empty states", () => {
    // empty → empty states
    const { rerender } = render(<ProjectPane focus={baseFocus({ phases: [ph("automations", "Automations", "active", 0, 1)], selectedIdx: 0, activeIdx: 0 })} />);
    expect(screen.getByText(/No automations yet/)).toBeInTheDocument();
    rerender(<ProjectPane focus={baseFocus({ phases: [ph("skills", "Skills", "active", 0, 1)], selectedIdx: 0, activeIdx: 0 })} />);
    expect(screen.getByText(/No skills attached/)).toBeInTheDocument();
    // populated
    const data = { agents: [], repos: [], structure: [], phaseStructure: [], context: [], issues: [],
      automations: [{ name: "nightly-deps", command: "npm audit", schedule: "0 2 * * *" }],
      skills: [{ name: "Rust review", kind: "skill", desc: "review checklist" }] } as unknown as Parameters<typeof ProjectPane>[0]["data"];
    rerender(<ProjectPane data={data} focus={baseFocus({ phases: [ph("automations", "Automations", "active", 0, 1)], selectedIdx: 0, activeIdx: 0 })} />);
    expect(screen.getByText("nightly-deps")).toBeInTheDocument();
    rerender(<ProjectPane data={data} focus={baseFocus({ phases: [ph("skills", "Skills", "active", 0, 1)], selectedIdx: 0, activeIdx: 0 })} />);
    expect(screen.getByText("Rust review")).toBeInTheDocument();
  });

  it("renders the Features board — empty state, then cards with defined/drafting badges (#…)", () => {
    const featuresPhase = { phases: [ph("features", "Features", "active", 0, 1)], selectedIdx: 0, activeIdx: 0 };
    const { rerender } = render(<ProjectPane focus={baseFocus(featuresPhase)} />);
    expect(screen.getByText(/Claude proposes a starter set/)).toBeInTheDocument();
    const data = { agents: [], repos: [], structure: [], phaseStructure: [], context: [], issues: [],
      features: [
        { slug: "invite", name: "Invite teammates", behavior: "send an invite", acceptance: ["email sent"], stream: "invite" },
        { slug: "export", name: "Export to CSV", stream: "export" }, // not fully defined
      ] } as unknown as Parameters<typeof ProjectPane>[0]["data"];
    rerender(<ProjectPane data={data} focus={baseFocus(featuresPhase)} />);
    expect(screen.getByText("Invite teammates")).toBeInTheDocument();
    expect(screen.getByText("✓ defined")).toBeInTheDocument();    // fully specified
    expect(screen.getByText("○ drafting")).toBeInTheDocument();    // missing behavior/acceptance
    // tiles summarize the workshop progress (the "defined" tile is distinct from the "✓ defined" badge)
    expect(screen.getByText("defined")).toBeInTheDocument();
  });

  it("expands a feature card to show the full workshop spec (#811-followup)", () => {
    const featuresPhase = { phases: [ph("features", "Features", "active", 0, 1)], selectedIdx: 0, activeIdx: 0 };
    const data = { agents: [], repos: [], structure: [], phaseStructure: [], context: [], issues: [],
      features: [
        { slug: "invite", name: "Invite teammates", behavior: "send an invite",
          approach: "POST /invites then email", tools: ["resend", "zod"], data: "writes invites table",
          acceptance: ["email is sent", "invite expires in 7d"], stream: "invite" },
      ] } as unknown as Parameters<typeof ProjectPane>[0]["data"];
    render(<ProjectPane data={data} focus={baseFocus(featuresPhase)} />);
    // The single fully-defined feature is collapsed by default — only its summary shows.
    expect(screen.getByText("send an invite")).toBeInTheDocument();
    expect(screen.getByText(/2 acceptance criteria/)).toBeInTheDocument();
    expect(screen.queryByText("email is sent")).not.toBeInTheDocument();
    // Expanding reveals approach, tools, data + deps, and the acceptance checklist.
    fireEvent.click(screen.getByText("Invite teammates"));
    expect(screen.getByText("approach")).toBeInTheDocument();
    expect(screen.getByText("POST /invites then email")).toBeInTheDocument();
    expect(screen.getByText("resend")).toBeInTheDocument();
    expect(screen.getByText("writes invites table")).toBeInTheDocument();
    expect(screen.getByText("email is sent")).toBeInTheDocument();
    expect(screen.getByText("invite expires in 7d")).toBeInTheDocument();
  });

  it("computes the real pinned token budget (not a hardcoded total)", () => {
    const data = { agents: [], repos: [], structure: [], phaseStructure: [], issues: [], context: [
      { name: "goal.md", kind: "doc", tok: "2.0k", pinned: true, scope: "project", content: "x" },
      { name: "scope.md", kind: "doc", tok: "1.5k", pinned: true, scope: "project", content: "y" },
    ] } as unknown as Parameters<typeof ProjectPane>[0]["data"];
    render(<ProjectPane data={data} focus={baseFocus()} />); // context phase active
    expect(screen.getByText("3.5k / 200k tok")).toBeInTheDocument();
    expect(screen.queryByText(/6\.7k/)).toBeNull(); // old hardcoded value gone
  });
});
