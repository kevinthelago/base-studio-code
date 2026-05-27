import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AutomationsScreen } from "../screens/automations";
import { useAppStore } from "../store";

beforeEach(() => {
  useAppStore.setState({ automationsTab: "schedules" });
});

describe("AutomationsScreen", () => {
  it("renders the schedules tab with the list and the editor sections", () => {
    render(<AutomationsScreen />);
    expect(screen.getByText("Nightly review digest")).toBeTruthy(); // a list row
    expect(screen.getByText("when")).toBeTruthy();
    expect(screen.getByText("target")).toBeTruthy();
    expect(screen.getByText("action")).toBeTruthy();
  });

  it("selects a schedule and reflects it in the editor", () => {
    const { container } = render(<AutomationsScreen />);
    fireEvent.click(screen.getByText("Bump weekly deps"));
    const nameInput = container.querySelector(".editor .name-input") as HTMLInputElement;
    expect(nameInput.value).toBe("Bump weekly deps");
  });

  it("switches to the history tab and filters the table by status", () => {
    const { container } = render(<AutomationsScreen />);
    // History is the 2nd subtab (avoids text-matching the count badge).
    fireEvent.click(container.querySelectorAll(".subtabs .t")[1]);
    expect(screen.getByText("success rate")).toBeTruthy();

    const dataRows = () => container.querySelectorAll(".hist-table .hist-row:not(.head)").length;
    const all = dataRows();
    expect(all).toBeGreaterThan(0);

    fireEvent.click(container.querySelector('.status-chip[data-st="fail"]') as HTMLElement);
    const fails = dataRows();
    expect(fails).toBeGreaterThan(0);
    expect(fails).toBeLessThan(all);
  });
});
