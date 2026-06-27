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

  it("renders the xs (24×14) size with a 10px knob", () => {
    const { container } = render(<Toggle on size="xs" className="xs-toggle" />);
    const track = container.querySelector("span.xs-toggle") as HTMLElement;
    expect(track).toBeTruthy();
    expect(track.style.width).toBe("24px");
    expect(track.style.height).toBe("14px");
    const knob = track.querySelector("span") as HTMLElement;
    expect(knob.style.width).toBe("10px");
  });

  it("uses the accent track by default when on", () => {
    const { container } = render(<Toggle on />);
    expect(container.querySelector("span")!.style.background).toContain("var(--accent)");
  });

  it("uses the success track + border when tone='success' and on", () => {
    const { container } = render(<Toggle on tone="success" size="sm" />);
    const track = container.querySelector("span")!;
    expect(track.style.background).toContain("var(--success)");
    expect(track.style.border).toContain("var(--success)");
  });

  it("ignores tone in the off state (neutral track)", () => {
    const { container } = render(<Toggle on={false} tone="success" />);
    expect(container.querySelector("span")!.style.background).toContain("var(--bg-elev2)");
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
