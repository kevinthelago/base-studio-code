import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppearanceSettings } from "../screens/settings/Appearance";
import { useAppStore } from "../store";
import { MAX_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_FONT_SIZE } from "../lib/terminal";

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
