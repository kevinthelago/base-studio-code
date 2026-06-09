import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppearanceSettings } from "../../screens/settings/Appearance";
import { DEFAULT_TERMINAL_FONT_SIZE } from "../../lib/terminal";

let terminalFontSize = DEFAULT_TERMINAL_FONT_SIZE;
const setTerminalFontSize = vi.fn((v: number) => { terminalFontSize = v; });
const setAccent = vi.fn();

vi.mock("../../store", () => ({
  useAppStore: (selector?: (s: object) => unknown) => {
    const state = { terminalFontSize, setTerminalFontSize, accent: "blue", setAccent };
    return selector ? selector(state) : state;
  },
}));

describe("AppearanceSettings smoke", () => {
  beforeEach(() => {
    localStorage.clear();
    terminalFontSize = DEFAULT_TERMINAL_FONT_SIZE;
    setTerminalFontSize.mockClear();
  });

  it("renders the heading", () => {
    render(<AppearanceSettings />);
    expect(screen.getByText("Appearance")).toBeInTheDocument();
  });

  it("renders Dark and Light theme buttons", () => {
    render(<AppearanceSettings />);
    expect(screen.getByText("Dark")).toBeInTheDocument();
    expect(screen.getByText("Light")).toBeInTheDocument();
  });

  it("renders the font size slider", () => {
    render(<AppearanceSettings />);
    expect(screen.getByRole("slider")).toBeInTheDocument();
  });

  it("displays the current terminal font size", () => {
    render(<AppearanceSettings />);
    expect(screen.getByText(`${DEFAULT_TERMINAL_FONT_SIZE}px`)).toBeInTheDocument();
  });
});

describe("AppearanceSettings theme toggle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
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

describe("AppearanceSettings font size controls", () => {
  beforeEach(() => {
    localStorage.clear();
    terminalFontSize = DEFAULT_TERMINAL_FONT_SIZE;
    setTerminalFontSize.mockClear();
  });

  it("calls setTerminalFontSize when the slider changes", () => {
    render(<AppearanceSettings />);
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "16" } });
    expect(setTerminalFontSize).toHaveBeenCalledWith(16);
  });

  it("calls setTerminalFontSize when − is clicked", () => {
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByLabelText("Decrease terminal font size"));
    expect(setTerminalFontSize).toHaveBeenCalledWith(DEFAULT_TERMINAL_FONT_SIZE - 1);
  });

  it("calls setTerminalFontSize when + is clicked", () => {
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByLabelText("Increase terminal font size"));
    expect(setTerminalFontSize).toHaveBeenCalledWith(DEFAULT_TERMINAL_FONT_SIZE + 1);
  });

  it("calls setTerminalFontSize with default when reset is clicked", () => {
    terminalFontSize = DEFAULT_TERMINAL_FONT_SIZE + 2;
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByText("reset"));
    expect(setTerminalFontSize).toHaveBeenCalledWith(DEFAULT_TERMINAL_FONT_SIZE);
  });
});
