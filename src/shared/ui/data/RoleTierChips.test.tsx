import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoleTierChips } from "./RoleTierChips";

describe("RoleTierChips (#2420)", () => {
  it("renders all four capability tiers for a role", () => {
    render(<RoleTierChips role="planner" />);
    // Planner floor per role-capabilities.json: git read · github read · code WRITE · net read.
    // "Plan-only" is encoded as code:write + writeGlobs scoped to the plan-section files (*.md,
    // prompts/*, …) — unlike the director, whose carve-out is encoded as code:none + globs (#851).
    expect(screen.getByText("git · read")).toBeTruthy();
    expect(screen.getByText("github · read")).toBeTruthy();
    expect(screen.getByText("code · write")).toBeTruthy();
    expect(screen.getByText("net · read")).toBeTruthy();
  });

  it("reflects a mutating role's write tiers", () => {
    render(<RoleTierChips role="worker" />);
    // Worker: git write · github read · code write (#219) — the fleet's actual mutating role.
    expect(screen.getByText("git · write")).toBeTruthy();
    expect(screen.getByText("github · read")).toBeTruthy();
    expect(screen.getByText("code · write")).toBeTruthy();
  });

  it("shows the director as read on git + github — it plans and routes, it does not mutate", () => {
    render(<RoleTierChips role="director" />);
    expect(screen.getByText("git · read")).toBeTruthy();
    expect(screen.getByText("github · read")).toBeTruthy();
    expect(screen.getByText("code · write")).toBeTruthy(); // the plan files
  });

  it("renders exactly four pills", () => {
    render(<RoleTierChips role="worker" />);
    expect(screen.getAllByText(/ · /).length).toBe(4);
  });
});
