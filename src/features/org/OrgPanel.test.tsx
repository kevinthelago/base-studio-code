// OrgPanel (#2193/#2333) — the Org designer opens with NO node selected (the empty sentinel), not
// focused on the first position (the director). Regression guard for #2333.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrgPanel } from "./OrgPanel";

describe("OrgPanel initial selection (#2333)", () => {
  it("opens with nothing selected — the inspector shows no position (no 'Persona' section)", () => {
    render(<OrgPanel />);
    // Sanity: the panel mounted over the seeded built-in library (Fleet Alpha is orgs[0]).
    expect(screen.getByText("Fleet Alpha")).toBeTruthy();
    // The inspector's persona section only renders when an agent node is selected. With the empty
    // sentinel default, nothing is selected → no 'Persona' section. (Under the old bug the first
    // position — the director, an agent — was pre-selected and this section rendered.)
    expect(screen.queryByText("Persona")).toBeNull();
  });

  it("switching orgs does not auto-focus a node either", () => {
    render(<OrgPanel />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "org-swarm" } });
    expect(select.value).toBe("org-swarm");
    // Still nothing selected after the switch.
    expect(screen.queryByText("Persona")).toBeNull();
  });
});
