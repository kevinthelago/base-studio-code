import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Field, TextField, SelectField } from "./Field";

describe("Field family", () => {
  it("Field renders the label, hint, and children in the .field stack", () => {
    const { container } = render(<Field label="Name" hint="one line"><input /></Field>);
    expect(container.querySelector(".field")).toBeTruthy();
    expect(screen.getByText("Name").tagName).toBe("LABEL");
    expect(screen.getByText("one line").className).toBe("hint");
  });

  it("TextField wires an .input and reports string changes", () => {
    const onChange = vi.fn();
    render(<TextField label="Repo" value="abc" onChange={onChange} placeholder="…" />);
    const input = screen.getByPlaceholderText("…") as HTMLInputElement;
    expect(input.className).toBe("input");
    expect(input.value).toBe("abc");
    fireEvent.change(input, { target: { value: "xyz" } });
    expect(onChange).toHaveBeenCalledWith("xyz");
  });

  it("SelectField renders an .input <select> over the given options", () => {
    const onChange = vi.fn();
    render(
      <SelectField label="Mode" value="b" onChange={onChange}>
        <option value="a">A</option>
        <option value="b">B</option>
      </SelectField>,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.className).toBe("input");
    expect(select.value).toBe("b");
    fireEvent.change(select, { target: { value: "a" } });
    expect(onChange).toHaveBeenCalledWith("a");
  });
});
