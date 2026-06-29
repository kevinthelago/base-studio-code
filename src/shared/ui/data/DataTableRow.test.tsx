import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DataTableHeader, DataTableRow } from "./DataTableRow";

describe("DataTableRow", () => {
  it("header + row share the template and render their cells", () => {
    const tmpl = "1fr 80px";
    const { container } = render(
      <div>
        <DataTableHeader template={tmpl}><span>Name</span><span>On</span></DataTableHeader>
        <DataTableRow template={tmpl}><span>alpha</span><span>yes</span></DataTableRow>
      </div>,
    );
    const header = container.querySelector(".dt-header") as HTMLElement;
    const row = container.querySelector(".dt-row") as HTMLElement;
    expect(header.style.gridTemplateColumns).toBe(tmpl);
    expect(row.style.gridTemplateColumns).toBe(tmpl);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("stripes odd rows, applies selected/off, fires onClick", () => {
    const onClick = vi.fn();
    const { container, rerender } = render(
      <DataTableRow template="1fr" index={1} onClick={onClick}><span>r</span></DataTableRow>,
    );
    const row = () => container.querySelector(".dt-row") as HTMLElement;
    expect(row().className).toContain("odd");
    fireEvent.click(row());
    expect(onClick).toHaveBeenCalledOnce();
    rerender(<DataTableRow template="1fr" index={0} selected off><span>r</span></DataTableRow>);
    expect(row().className).not.toContain("odd");
    expect(row().className).toContain("selected");
    expect(row().className).toContain("off");
  });
});
