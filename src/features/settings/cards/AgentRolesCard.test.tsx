import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { AgentRolesCard } from "./AgentRolesCard";
import { ROLE_DEFAULTS, roleDeniedCommands, type SessionRole } from "@/shared/lib/session/sessionRoles";
import { roleProfileId } from "@/shared/lib/session/roleProfile";

const ROLES = Object.keys(ROLE_DEFAULTS) as SessionRole[];

describe("AgentRolesCard", () => {
  it("renders a row for every role in ROLE_DEFAULTS (no hardcoded list)", () => {
    render(<AgentRolesCard />);
    // The roster derives live from the enforcement core — every role surfaces.
    for (const role of ROLES) {
      expect(screen.getByText(role)).toBeInTheDocument();
    }
    // Sanity: a known-present and a known-absent role.
    expect(screen.getByText("planner")).toBeInTheDocument();
    expect(screen.queryByText("nonexistent-role")).not.toBeInTheDocument();
  });

  it("shows the five capability-tier chips per role with their access tier", () => {
    render(<AgentRolesCard />);
    // The worker's tiers appear (git write, github read, code write, ui read). Use getAllByText —
    // several roles legitimately share a tier (worker + director both have `git: write`), so these
    // are not unique across the roster.
    const cap = ROLE_DEFAULTS.worker;
    expect(screen.getAllByText(`git: ${cap.git}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`github: ${cap.github}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`code: ${cap.code}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`ui: ${cap.ui}`).length).toBeGreaterThan(0); // the #2470 axis surfaces
    // Every role contributes 5 axis chips → exactly 5 × role count on the page.
    expect(screen.getAllByText(/^(git|github|code|net|ui): /).length).toBe(ROLES.length * 5);
  });

  it("surfaces each role's default profile", () => {
    render(<AgentRolesCard />);
    // A profile id can back several roles (e.g. worker + documentor both use pf_auto), so it may
    // appear more than once — assert presence, not uniqueness.
    expect(screen.getAllByText(roleProfileId("planner")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(roleProfileId("worker")).length).toBeGreaterThan(0);
  });

  it("expands a role's denied commands on demand", () => {
    render(<AgentRolesCard />);
    // The planner denies mutating git/gh commands; its toggle exists and reveals them.
    const denied = roleDeniedCommands(ROLE_DEFAULTS.planner);
    expect(denied.length).toBeGreaterThan(0);
    // Scope to the planner's row — the "Show N denied" button label collides across roles with the
    // same denied count, so climb from the role name to the row that owns a denied-command toggle.
    let row: HTMLElement | null = screen.getByText("planner");
    while (row && !within(row).queryByRole("button", { name: /denied command/ })) row = row.parentElement;
    expect(row).not.toBeNull();
    const toggle = within(row!).getByRole("button", { name: /denied command/ });
    fireEvent.click(toggle);
    expect(within(row!).getByText(denied[0])).toBeInTheDocument();
  });
});
