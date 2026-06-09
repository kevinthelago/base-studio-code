import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GeneralSettings } from "../../screens/settings/General";

const setBscBaseDir = vi.fn();
const setAutoResumeClaude = vi.fn();
const setDefaultModel = vi.fn();
const setAutoAdvanceOnReply = vi.fn();

vi.mock("../../store", () => ({
  useAppStore: (selector?: (s: object) => unknown) => {
    const state = {
      bscBaseDir: "/test/base",
      setBscBaseDir,
      autoResumeClaude: false,
      setAutoResumeClaude,
      defaultModel: "haiku-4.5",
      setDefaultModel,
      autoAdvanceOnReply: false,
      setAutoAdvanceOnReply,
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("GeneralSettings smoke", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders the heading", () => {
    render(<GeneralSettings />);
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("renders the base directory input with the store value", () => {
    render(<GeneralSettings />);
    const input = screen.getByPlaceholderText("~/.base-studio-code") as HTMLInputElement;
    expect(input.value).toBe("/test/base");
  });

  it("renders the default model selector", () => {
    render(<GeneralSettings />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("renders the auto-resume toggle", () => {
    render(<GeneralSettings />);
    expect(screen.getByText("Auto-resume Claude on restart")).toBeInTheDocument();
  });
});

describe("GeneralSettings interactions", () => {
  beforeEach(() => {
    localStorage.clear();
    setBscBaseDir.mockClear();
    setAutoResumeClaude.mockClear();
    setDefaultModel.mockClear();
  });

  it("calls setBscBaseDir when the input changes", () => {
    render(<GeneralSettings />);
    const input = screen.getByPlaceholderText("~/.base-studio-code");
    fireEvent.change(input, { target: { value: "/new/path" } });
    expect(setBscBaseDir).toHaveBeenCalledWith("/new/path");
  });

  it("shows the store's default model in the selector", () => {
    render(<GeneralSettings />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("haiku-4.5");
  });

  it("calls setDefaultModel when the model selector changes", () => {
    render(<GeneralSettings />);
    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "sonnet-4.5" } });
    expect(setDefaultModel).toHaveBeenCalledWith("sonnet-4.5");
  });

  it("calls setAutoResumeClaude when the toggle is clicked", () => {
    render(<GeneralSettings />);
    // The Toggle span carries role="switch" but has no explicit aria-label —
    // grab the first switch (auto-resume) which precedes autoAdvanceOnReply.
    fireEvent.click(screen.getAllByRole("switch")[0]);
    expect(setAutoResumeClaude).toHaveBeenCalledWith(true);
  });
});
