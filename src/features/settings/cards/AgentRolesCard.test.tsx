import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

  it("shows the four capability-tier chips per role with their access tier", () => {
    render(<AgentRolesCard />);
    // The worker is the richest row: git write, github read, code write.
    const cap = ROLE_DEFAULTS.worker;
    expect(screen.getByText(`git: ${cap.git}`)).toBeInTheDocument();
    expect(screen.getByText(`github: ${cap.github}`)).toBeInTheDocument();
    expect(screen.getByText(`code: ${cap.code}`)).toBeInTheDocument();
    // Every role contributes 4 axis chips → at least 4 × role count on the page.
    expect(screen.getAllByText(/^(git|github|code|net): /).length).toBe(ROLES.length * 4);
  });

  it("surfaces each role's default profile", () => {
    render(<AgentRolesCard />);
    expect(screen.getByText(roleProfileId("planner"))).toBeInTheDocument();
    expect(screen.getByText(roleProfileId("worker"))).toBeInTheDocument();
  });

  it("expands a role's denied commands on demand", () => {
    render(<AgentRolesCard />);
    // The planner denies mutating git/gh commands; its toggle exists and reveals them.
    const denied = roleDeniedCommands(ROLE_DEFAULTS.planner);
    expect(denied.length).toBeGreaterThan(0);
    const toggle = screen.getByRole("button", { name: new RegExp(`Show ${denied.length} denied`) });
    fireEvent.click(toggle);
    expect(screen.getByText(denied[0])).toBeInTheDocument();
  });
});
