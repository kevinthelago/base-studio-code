// RecordPage (#2508) — the key-value-shaped page composition: the identity header (title · status
// Chip · subtitle · actions), grouped SectionLabel + KeyValueList sections, the optional side
// column, and the empty state.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RecordPage, type RecordSection } from "./RecordPage";

const SECTIONS: RecordSection[] = [
  { label: "Session", entries: [{ k: "model", v: "opus" }, { k: "role", v: "worker" }] },
  { label: "Worktree", entries: [{ k: "branch", v: "2409-name-derived-key" }] },
];

describe("RecordPage — the identity header", () => {
  it("renders title, subtitle, and the status Chip", () => {
    const { container } = render(
      <RecordPage title="api-builder" subtitle="stream api" status="running" statusTone="success" sections={SECTIONS} />,
    );
    expect(screen.getByText("api-builder")).toBeInTheDocument();
    expect(screen.getByText("stream api")).toBeInTheDocument();
    const chip = screen.getByText("running");
    expect(chip.closest(".chip")?.className).toContain("tone-success");
    expect(container.querySelector(".section-header")).toBeTruthy();
  });

  it("omits the Chip without a status and renders the actions slot", () => {
    const onEdit = vi.fn();
    const { container } = render(
      <RecordPage title="api-builder" sections={SECTIONS} actions={<button onClick={onEdit}>Edit</button>} />,
    );
    expect(container.querySelector(".chip")).toBeNull();
    fireEvent.click(screen.getByText("Edit"));
    expect(onEdit).toHaveBeenCalled();
  });
});

describe("RecordPage — sections + aside + empty", () => {
  it("renders one labelled KeyValueList per section, entries in order", () => {
    render(<RecordPage title="api-builder" sections={SECTIONS} />);
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByText("Worktree")).toBeInTheDocument();
    expect(screen.getByText("model")).toBeInTheDocument();
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("branch")).toBeInTheDocument();
    expect(screen.getByText("2409-name-derived-key")).toBeInTheDocument();
  });

  it("renders the side column only when `aside` is given", () => {
    const { rerender } = render(<RecordPage title="api-builder" sections={SECTIONS} />);
    expect(screen.queryByText("ASIDE")).toBeNull();
    rerender(<RecordPage title="api-builder" sections={SECTIONS} aside={<span>ASIDE</span>} asideWidth={240} />);
    const aside = screen.getByText("ASIDE");
    expect(aside).toBeInTheDocument();
    expect((aside.parentElement as HTMLElement).style.width).toBe("240px");
  });

  it("renders the EmptyState when there are no sections", () => {
    render(<RecordPage title="api-builder" sections={[]} />);
    expect(screen.getByText("No fields yet")).toBeInTheDocument();
  });
});
