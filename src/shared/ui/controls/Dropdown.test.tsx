import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Dropdown } from "./Dropdown";

const OPTS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

describe("Dropdown (#2675)", () => {
  it("shows the selected option's label on the trigger, with listbox aria", () => {
    render(<Dropdown value="b" onChange={() => {}} options={OPTS} aria-label="pick" />);
    const trigger = screen.getByRole("button", { name: "pick" });
    expect(trigger).toHaveTextContent("Beta");
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the placeholder when the value matches no option", () => {
    render(<Dropdown value="zzz" onChange={() => {}} options={OPTS} placeholder="Choose…" aria-label="pick" />);
    expect(screen.getByRole("button", { name: "pick" })).toHaveTextContent("Choose…");
  });

  it("opens a listbox on click, marking the selected option", () => {
    render(<Dropdown value="b" onChange={() => {}} options={OPTS} aria-label="pick" />);
    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    const beta = screen.getByRole("option", { name: "Beta" });
    expect(beta).toHaveAttribute("aria-selected", "true");
    expect(beta.className).toContain("selected");
    expect(screen.getByRole("button", { name: "pick" })).toHaveAttribute("aria-expanded", "true");
  });

  it("selecting an option fires onChange with its value and closes the menu", () => {
    const onChange = vi.fn();
    render(<Dropdown value="a" onChange={onChange} options={OPTS} aria-label="pick" />);
    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    fireEvent.click(screen.getByRole("option", { name: "Gamma" }));
    expect(onChange).toHaveBeenCalledWith("c");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keyboard: ArrowDown moves the active option and Enter selects it", () => {
    const onChange = vi.fn();
    render(<Dropdown value="a" onChange={onChange} options={OPTS} aria-label="pick" />);
    fireEvent.click(screen.getByRole("button", { name: "pick" })); // active = 0 (Alpha)
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });                 // → 1 (Beta)
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("Escape closes without selecting", () => {
    const onChange = vi.fn();
    render(<Dropdown value="a" onChange={onChange} options={OPTS} aria-label="pick" />);
    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("skips a disabled option with the keyboard and won't select it on click", () => {
    const onChange = vi.fn();
    const opts = [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta", disabled: true },
      { value: "c", label: "Gamma" },
    ];
    render(<Dropdown value="a" onChange={onChange} options={opts} aria-label="pick" />);
    fireEvent.click(screen.getByRole("button", { name: "pick" }));  // active = 0
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" }); // skip disabled Beta → Gamma
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("c");

    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    fireEvent.click(screen.getByRole("option", { name: "Beta" }));  // disabled → no-op
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not open when disabled", () => {
    render(<Dropdown value="a" onChange={() => {}} options={OPTS} aria-label="pick" disabled />);
    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("applies the variant + size classes to the trigger", () => {
    render(<Dropdown value="a" onChange={() => {}} options={OPTS} aria-label="pick" variant="ghost" size="md" />);
    const trigger = screen.getByRole("button", { name: "pick" });
    expect(trigger.className).toContain("v-ghost");
    expect(trigger.className).toContain("sz-md");
  });
});
