import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Toggle } from "./Toggle";
import { ConfirmButton } from "./ConfirmButton";

describe("Toggle", () => {
  it("fires onClick when clicked", () => {
    const onClick = vi.fn();
    const { container } = render(<Toggle on={false} onClick={onClick} />);
    fireEvent.click(container.querySelector("span")!);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders both sizes and forwards className (sm)", () => {
    const { container } = render(<Toggle on size="sm" className="sess-toggle" />);
    expect(container.querySelector("span.sess-toggle")).toBeTruthy();
  });
});

describe("ConfirmButton", () => {
  it("arms on the first click, fires onConfirm on the second", () => {
    const onConfirm = vi.fn();
    const { getByRole } = render(<ConfirmButton label="Delete" armedLabel="Confirm" onConfirm={onConfirm} />);
    const btn = getByRole("button");
    expect(btn.textContent).toBe("Delete");
    fireEvent.click(btn);
    expect(btn.textContent).toBe("Confirm");
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("disarms on blur", () => {
    const onConfirm = vi.fn();
    const { getByRole } = render(<ConfirmButton label="Del" armedLabel="Sure?" onConfirm={onConfirm} />);
    const btn = getByRole("button");
    fireEvent.click(btn);
    expect(btn.textContent).toBe("Sure?");
    fireEvent.blur(btn);
    expect(btn.textContent).toBe("Del");
  });

  it("respects disabled", () => {
    const { getByRole } = render(<ConfirmButton label="X" armedLabel="Y" onConfirm={() => {}} disabled />);
    expect((getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
