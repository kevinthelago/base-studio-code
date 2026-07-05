import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrgContextMenu } from "./OrgContextMenu";

describe("OrgContextMenu (#2385)", () => {
  it("fires delete + close when the item is clicked", () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(<OrgContextMenu x={10} y={20} deleteLabel="Delete position" onDelete={onDelete} onClose={onClose} />);
    fireEvent.click(screen.getByText("Delete position"));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<OrgContextMenu x={0} y={0} deleteLabel="Delete relationship" onDelete={() => {}} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a backdrop click (without deleting)", () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    const { getByRole } = render(<OrgContextMenu x={0} y={0} deleteLabel="Delete position" onDelete={onDelete} onClose={onClose} />);
    // The menu item is inside role=menu; the backdrop is the fixed sibling — click outside the menu.
    fireEvent.click(getByRole("menu").previousSibling as Element);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
