import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppearanceSettings } from "./Appearance";
import { useAppStore } from "@/store";
import { MAX_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_FONT_SIZE } from "@/lib/console/terminal";

describe("AppearanceSettings", () => {
  beforeEach(() => {
    useAppStore.setState({ terminalFontSize: 12, accent: "amber" });
  });

  it("renders the appearance cards (no 'coming soon')", () => {
    render(<AppearanceSettings />);
    expect(screen.getByText("Appearance")).toBeTruthy();
    expect(screen.getByText("Terminal font size")).toBeTruthy();
    expect(screen.getByText("Accent color")).toBeTruthy();
  });

  it("renders the font size slider and the theme buttons", () => {
    render(<AppearanceSettings />);
    expect(screen.getByRole("slider")).toBeTruthy();
    expect(screen.getByText("Dark")).toBeTruthy();
    expect(screen.getByText("Light")).toBeTruthy();
  });

  it("steps the terminal font size up and down via the store", () => {
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByLabelText("Increase terminal font size"));
    expect(useAppStore.getState().terminalFontSize).toBe(13);
    fireEvent.click(screen.getByLabelText("Decrease terminal font size"));
    expect(useAppStore.getState().terminalFontSize).toBe(12);
  });

  it("clamps the slider and resets to the default", () => {
    render(<AppearanceSettings />);
    const slider = screen.getByLabelText("Terminal font size") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: String(MAX_TERMINAL_FONT_SIZE + 10) } });
    // setTerminalFontSize clamps to the legible ceiling.
    expect(useAppStore.getState().terminalFontSize).toBe(MAX_TERMINAL_FONT_SIZE);
    fireEvent.click(screen.getByText("reset"));
    expect(useAppStore.getState().terminalFontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("selects an accent preset and persists it to the store", () => {
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByLabelText("Blue"));
    expect(useAppStore.getState().accent).toBe("blue");
    const blueBtn = screen.getByLabelText("Blue");
    expect(blueBtn.getAttribute("aria-pressed")).toBe("true");
  });
});

// Theme toggle is self-contained in the component (useTheme → localStorage + data-theme),
// independent of the store. Consolidated here from the former AppearanceSettings smoke test.
describe("AppearanceSettings — theme toggle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    useAppStore.setState({ terminalFontSize: 12, accent: "amber" });
  });

  it("defaults to dark theme", () => {
    render(<AppearanceSettings />);
    expect(localStorage.getItem("bsc-theme")).toBe("dark");
  });

  it("sets data-theme on the html element", () => {
    render(<AppearanceSettings />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("switches to light theme when Light is clicked", () => {
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByText("Light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("bsc-theme")).toBe("light");
  });
});
