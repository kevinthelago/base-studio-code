import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GeneralSettings, DEFAULT_MODEL_STORAGE_KEY, DEFAULT_MODEL } from "../../screens/settings/General";

const setBscBaseDir = vi.fn();
const setAutoResumeClaude = vi.fn();

vi.mock("../../store", () => ({
  useAppStore: (selector?: (s: object) => unknown) => {
    const state = {
      bscBaseDir: "/test/base",
      setBscBaseDir,
      autoResumeClaude: false,
      setAutoResumeClaude,
    };
    return selector ? selector(state) : state;
  },
}));

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
  });

  it("calls setBscBaseDir when the input changes", () => {
    render(<GeneralSettings />);
    const input = screen.getByPlaceholderText("~/.base-studio-code");
    fireEvent.change(input, { target: { value: "/new/path" } });
    expect(setBscBaseDir).toHaveBeenCalledWith("/new/path");
  });

  it("reads default model from localStorage when set", () => {
    localStorage.setItem(DEFAULT_MODEL_STORAGE_KEY, "claude-opus-4-8");
    render(<GeneralSettings />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("claude-opus-4-8");
  });

  it("falls back to DEFAULT_MODEL when localStorage is empty", () => {
    render(<GeneralSettings />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe(DEFAULT_MODEL);
  });

  it("persists model change to localStorage", () => {
    render(<GeneralSettings />);
    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "claude-haiku-4-5" } });
    expect(localStorage.getItem(DEFAULT_MODEL_STORAGE_KEY)).toBe("claude-haiku-4-5");
  });
});
