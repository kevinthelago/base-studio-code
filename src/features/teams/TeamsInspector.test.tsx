// The panel PRESENTS; it does not edit (#2382). The two tests this file replaced drove the
// two-step delete confirms added as interim manual overrides (#2383/#2384) — those controls are gone,
// so the assertions that would have caught a regression are inverted: no control in this panel may
// write team, position, persona or relationship data.
//
// The guard is written against the RENDERED ROLES rather than against component names, because that is
// what a user can actually reach: a `<button>`, a `<textbox>`, a `<combobox>` or a `<checkbox>` inside
// the inspector IS an editing affordance no matter which primitive drew it. A future change that
// reintroduces one — by any route — fails here.
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { TeamsInspector } from "@/features/teams/TeamsInspector";
import { RELATIONSHIP_ARCHETYPES, type Team } from "./lib/team";
import type { Persona } from "@/features/personas";

const worker: Persona = {
  id: "p-worker",
  name: "Worker",
  blurb: "Executes one issue in its own worktree.",
  role: "worker",
  startPrompt: "You own exactly one issue.",
  skills: ["skill-testing"],
  responsibilities: ["Land the issue", "Write its tests"],
  model: "claude-sonnet-4-6",
};

/** A read-only persona with the tightest floor in the table — `designer` is `none` on git/github/code
 *  and `write` on ui, so it proves the tier chips render a real row rather than one hardcoded shape. */
const designer: Persona = {
  id: "p-designer", name: "Designer", blurb: "Owns the UI kit.",
  role: "designer", startPrompt: "", skills: [],
};

const org: Team = {
  id: "o1",
  name: "Test org",
  positions: [
    { nodeId: "n1", kind: "agent", personaId: "p-worker" },
    { nodeId: "n2", kind: "resource", label: "Ledger" },
    { nodeId: "n3", kind: "agent", personaId: "p-designer" },
  ],
  relationships: [{ id: "r1", archetype: RELATIONSHIP_ARCHETYPES[0].id, from: "n1", to: "n2" }],
};

const baseProps = { org, orgs: [org], personas: [worker, designer], onSelectNode: () => {} };

/** Every interactive control a user could type into or press, across every role the panel might use. */
const editingControls = (root: HTMLElement) => [
  ...within(root).queryAllByRole("button"),
  ...within(root).queryAllByRole("textbox"),
  ...within(root).queryAllByRole("combobox"),
  ...within(root).queryAllByRole("checkbox"),
  ...within(root).queryAllByRole("spinbutton"),
  ...root.querySelectorAll("input, textarea, select"),
];

describe("TeamsInspector — presents, never edits (#2382)", () => {
  it("renders NO editing control for a selected position", () => {
    const { container } = render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n1" }} />);
    expect(editingControls(container)).toHaveLength(0);
  });

  it("renders NO editing control for a selected relationship", () => {
    const { container } = render(<TeamsInspector {...baseProps} sel={{ type: "edge", id: "r1" }} />);
    expect(editingControls(container)).toHaveLength(0);
  });

  it("renders NO editing control for a resource position (the label field is gone)", () => {
    const { container } = render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n2" }} />);
    expect(editingControls(container)).toHaveLength(0);
    expect(screen.getByText("Ledger")).toBeTruthy();               // still SHOWN, in the header
    expect(screen.getAllByText("Resource")).toHaveLength(1);       // its kind, stated once
    expect(screen.getByText(/A shared resource/)).toBeTruthy();    // and what that kind means
  });

  it("names the surface that does the writing, so a removed control is not just missing", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getByText("bsc teams")).toBeTruthy();
    expect(screen.getByText("bsc persona")).toBeTruthy();
  });
});

describe("TeamsInspector — the persona is presented in full", () => {
  it("shows every field the removed editor let you type: charter, model, skills, prompt", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getByText("Worker")).toBeTruthy();     // once — the header names the position
    expect(screen.getByText("Executes one issue in its own worktree.")).toBeTruthy();
    expect(screen.getByText("Land the issue")).toBeTruthy();
    expect(screen.getByText("claude-sonnet-4-6")).toBeTruthy();
    expect(screen.getByText("skill-testing")).toBeTruthy();
    expect(screen.getByText("You own exactly one issue.")).toBeTruthy();
  });

  it("says so when a persona has no start prompt, naming the role it falls back to", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n3" }} />);
    expect(screen.getByText(/falls back to the designer role/)).toBeTruthy();
  });

  it("an agent position with no persona bound renders the empty identity, not a crash", () => {
    const bare: Team = { ...org, positions: [{ nodeId: "n9", kind: "agent" }], relationships: [] };
    render(<TeamsInspector {...baseProps} org={bare} orgs={[bare]} sel={{ type: "node", id: "n9" }} />);
    expect(screen.getByText(/No persona bound/)).toBeTruthy();
  });
});

describe("TeamsInspector — the role capability floor (moved off the Settings card)", () => {
  it("renders all five access tiers for the persona's role, read from the enforcement core", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n1" }} />);
    // `worker`: git·write, github·read, code·write, net·read, ui·read (role-capabilities.json).
    for (const chip of ["git · write", "github · read", "code · write", "net · read", "ui · read"]) {
      expect(screen.getByText(chip), `missing tier chip: ${chip}`).toBeTruthy();
    }
  });

  it("follows the role, not a hardcoded row — the designer floor differs on every axis that should", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n3" }} />);
    for (const chip of ["git · none", "github · none", "code · none", "net · none", "ui · write"]) {
      expect(screen.getByText(chip), `missing tier chip: ${chip}`).toBeTruthy();
    }
  });

  it("shows the write-scope globs when the role has them, and an em-dash when it has none", () => {
    // designer carries `scratch/**`; worker's writeGlobs are empty (its lane is scoped per-assignment,
    // not by the role table). Both branches, so neither can rot into always-rendering one shape.
    const { unmount } = render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n3" }} />);
    expect(screen.getByText("write-scope")).toBeTruthy();
    expect(screen.getByText("scratch/**")).toBeTruthy();
    unmount();
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("carries no capability block for a resource position — it runs nothing", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n2" }} />);
    expect(screen.queryByText("Capability")).toBeNull();
  });
});

describe("TeamsInspector — the identity block never echoes the header", () => {
  it("omits the persona name when the header already IS that name", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getAllByText("Worker")).toHaveLength(1);
  });

  it("shows the persona name when the position carries a local label override", () => {
    const labelled: Team = { ...org, positions: [{ nodeId: "n1", kind: "agent", personaId: "p-worker", label: "Engineer A" }] };
    render(<TeamsInspector {...baseProps} org={labelled} orgs={[labelled]} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getByText("Engineer A")).toBeTruthy();  // the position
    expect(screen.getByText("Worker")).toBeTruthy();      // the shared identity behind it
  });
});
