import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SegmentedControl } from "./SegmentedControl";

describe("SegmentedControl", () => {
  it("renders options, marks the active one, and fires onClick", () => {
    const pick = vi.fn();
    render(
      <SegmentedControl
        label="scope"
        options={[
          { label: "global", on: true, onClick: () => pick("global") },
          { label: "project", on: false, onClick: () => pick("project") },
        ]}
      />,
    );
    expect(screen.getByText("scope")).toBeInTheDocument();
    const global = screen.getByText("global");
    const project = screen.getByText("project");
    expect(global.className).toContain("on");
    expect(project.className).not.toContain("on");
    fireEvent.click(project);
    expect(pick).toHaveBeenCalledWith("project");
  });

  it("applies variant, size, tone, and dot", () => {
    const { container } = render(
      <SegmentedControl
        variant="joined"
        size="md"
        options={[
          { label: "deny", on: true, onClick: () => {}, tone: "deny", dot: true },
          { label: "allow", on: false, onClick: () => {}, tone: "allow" },
        ]}
      />,
    );
    expect(container.querySelector(".seg-grp.joined.size-md")).not.toBeNull();
    const deny = screen.getByText("deny").closest("button") as HTMLElement;
    expect(deny.className).toContain("tone-deny");
    expect(deny.className).toContain("on");
    expect(deny.querySelector(".seg-dot")).not.toBeNull();
  });
});
