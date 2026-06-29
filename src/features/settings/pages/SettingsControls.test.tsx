import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsCardHead, SettingsRow, SettingsSelect, SettingsTextField, SettingsSelectField } from "./SettingsControls";

describe("SettingsCardHead", () => {
  it("renders the title, and the hint only when provided", () => {
    const { rerender } = render(<SettingsCardHead title="Workspace" />);
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeTruthy();
    expect(screen.queryByText("a hint")).toBeNull();
    rerender(<SettingsCardHead title="Accent" hint="a hint" />);
    expect(screen.getByText("a hint")).toBeTruthy();
  });

  it("renders a right control when given", () => {
    render(<SettingsCardHead title="T" right={<button>act</button>} />);
    expect(screen.getByText("act")).toBeTruthy();
  });
});

describe("SettingsRow", () => {
  it("renders label, optional hint, and children", () => {
    render(<SettingsRow label="Enable" hint="why"><span>ctl</span></SettingsRow>);
    expect(screen.getByText("Enable")).toBeTruthy();
    expect(screen.getByText("why")).toBeTruthy();
    expect(screen.getByText("ctl")).toBeTruthy();
  });
});

describe("SettingsSelect", () => {
  it("renders options and returns a number for a numeric value", () => {
    const onChange = vi.fn();
    render(<SettingsSelect value={2} options={[{ label: "One", value: 1 }, { label: "Two", value: 2 }]} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "1" } });
    expect(onChange).toHaveBeenCalledWith(1);
    expect(typeof onChange.mock.calls[0][0]).toBe("number");
  });

  it("returns a string for a string value", () => {
    const onChange = vi.fn();
    render(<SettingsSelect value="a" options={[{ label: "A", value: "a" }, { label: "B", value: "b" }]} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("SettingsTextField", () => {
  it("renders label/hint, reflects value, and emits the raw string on change", () => {
    const onChange = vi.fn();
    render(<SettingsTextField label="Base directory" hint="where things live" value="~/x" onChange={onChange} placeholder="~/.base-studio-code" />);
    expect(screen.getByText("Base directory")).toBeTruthy();
    expect(screen.getByText("where things live")).toBeTruthy();
    const input = screen.getByPlaceholderText("~/.base-studio-code") as HTMLInputElement;
    expect(input.value).toBe("~/x");
    fireEvent.change(input, { target: { value: "~/y" } });
    expect(onChange).toHaveBeenCalledWith("~/y");
  });

  it("renders a trailing control beside the input when given", () => {
    render(<SettingsTextField label="Base directory" value="" onChange={() => {}} trailing={<button>Choose…</button>} />);
    expect(screen.getByRole("button", { name: "Choose…" })).toBeTruthy();
  });
});

describe("SettingsSelectField", () => {
  it("renders options and emits the selected value", () => {
    const onChange = vi.fn();
    render(
      <SettingsSelectField label="Model" value="a" onChange={onChange}>
        <option value="a">A</option>
        <option value="b">B</option>
      </SettingsSelectField>,
    );
    expect(screen.getByText("Model")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
  });
});
