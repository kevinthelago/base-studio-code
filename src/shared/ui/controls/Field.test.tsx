import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Field, TextField, TextArea, SelectField } from "./Field";

describe("Field family", () => {
  it("Field renders the label, hint, and children in the .field stack", () => {
    const { container } = render(<Field label="Name" hint="one line"><input /></Field>);
    expect(container.querySelector(".field")).toBeTruthy();
    expect(screen.getByText("Name").tagName).toBe("LABEL");
    expect(screen.getByText("one line").className).toBe("hint");
  });

  it("Field merges a wrapper className and style onto the .field div", () => {
    const { container } = render(<Field className="extra" style={{ marginBottom: 18 }}><input /></Field>);
    const field = container.querySelector(".field") as HTMLDivElement;
    expect(field.className).toBe("field extra");
    expect(field.style.marginBottom).toBe("18px");
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

  it("TextArea wires an .input <textarea> in the .field stack and reports string changes", () => {
    const onChange = vi.fn();
    const { container } = render(<TextArea label="Prompt" value="draft" onChange={onChange} placeholder="steps…" />);
    const ta = screen.getByPlaceholderText("steps…") as HTMLTextAreaElement;
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta.className).toBe("input");
    expect(ta.value).toBe("draft");
    // label wiring: the label renders inside the same .field stack as the textarea
    const field = container.querySelector(".field") as HTMLDivElement;
    expect(screen.getByText("Prompt").tagName).toBe("LABEL");
    expect(field.contains(screen.getByText("Prompt"))).toBe(true);
    expect(field.contains(ta)).toBe(true);
    fireEvent.change(ta, { target: { value: "draft + more" } });
    expect(onChange).toHaveBeenCalledWith("draft + more");
  });

  it("TextArea merges an extra className and passes native textarea attrs through", () => {
    render(<TextArea value="" onChange={() => {}} className="ta" spellCheck={false} data-testid="ta" />);
    const ta = screen.getByTestId("ta") as HTMLTextAreaElement;
    expect(ta.className).toBe("input ta");
    // Assert the attribute, not the `.spellcheck` property — jsdom doesn't implement that IDL
    // reflection on textarea, so the property reads undefined even when the attr passed through.
    expect(ta.getAttribute("spellcheck")).toBe("false");
  });

  it("TextArea loading renders the skeleton instead of the textarea, keeping the label", () => {
    const { container } = render(<TextArea label="Prompt" value="x" onChange={() => {}} loading />);
    expect(container.querySelector("textarea")).toBeNull();
    expect(screen.getByText("Prompt").tagName).toBe("LABEL");
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

  it("SelectField passes native select attrs (style, title) through to the <select>", () => {
    render(
      <SelectField value="a" onChange={() => {}} style={{ width: 240 }} title="pick">
        <option value="a">A</option>
      </SelectField>,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.style.width).toBe("240px");
    expect(select.title).toBe("pick");
  });
});
