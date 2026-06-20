import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Rail } from "./Rail";

// The rail's top→bottom order is product-defined (#872); lock it so a stray
// reorder is caught. Buttons carry the screen label as their `title`.
const ORDER = [
  "Console", "Projects", "GitHub", "Permissions", "MCP",
  "Skills", "Automations", "Knowledge Store", "Settings",
];

describe("Rail", () => {
  it("renders the nav screens in the defined order", () => {
    const { container } = render(<Rail active="console" onNavigate={() => {}} />);
    const titles = Array.from(container.querySelectorAll(".rail button")).map(b => b.getAttribute("title"));
    expect(titles).toEqual(ORDER);
  });

  it("labels the Agents screen 'Permissions' and navigates by its key", () => {
    const onNavigate = vi.fn();
    const { container } = render(<Rail active="console" onNavigate={onNavigate} />);
    const permissions = container.querySelector('.rail button[title="Permissions"]') as HTMLElement;
    expect(permissions).toBeTruthy();
    fireEvent.click(permissions);
    expect(onNavigate).toHaveBeenCalledWith("agents");
  });

  it("marks the active screen", () => {
    const { container } = render(<Rail active="github" onNavigate={() => {}} />);
    const active = container.querySelector(".rail button.active") as HTMLElement;
    expect(active.getAttribute("title")).toBe("GitHub");
  });
});
