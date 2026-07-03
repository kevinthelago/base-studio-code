// MasterDetail (#2197/#2198) — the standardized list+detail page skeleton: rail + detail slots, an
// optional toolbar above, and a fixed (or, #2209, drag-resizable) railWidth owned by the template.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MasterDetail } from "./MasterDetail";

describe("MasterDetail (#2197)", () => {
  it("renders the rail, detail, and toolbar slots", () => {
    render(<MasterDetail toolbar={<span>TOOLBAR</span>} rail={<span>RAIL</span>} detail={<span>DETAIL</span>} />);
    expect(screen.getByText("TOOLBAR")).toBeInTheDocument();
    expect(screen.getByText("RAIL")).toBeInTheDocument();
    expect(screen.getByText("DETAIL")).toBeInTheDocument();
  });

  it("omits the toolbar when not provided", () => {
    render(<MasterDetail rail={<span>RAIL</span>} detail={<span>DETAIL</span>} />);
    expect(screen.queryByText("TOOLBAR")).toBeNull();
    expect(screen.getByText("RAIL")).toBeInTheDocument();
  });

  it("gives the rail the requested fixed width", () => {
    render(<MasterDetail railWidth={300} rail={<span>RAIL</span>} detail={<span>DETAIL</span>} />);
    const railBox = screen.getByText("RAIL").parentElement as HTMLElement;
    expect(railBox.style.width).toBe("300px");
    expect(railBox.style.flex).toContain("300px");
  });

  it("has no resize splitter in the default (fixed) mode", () => {
    const { container } = render(<MasterDetail rail={<span>RAIL</span>} detail={<span>DETAIL</span>} />);
    expect(container.querySelector(".resize-x")).toBeNull();
  });
});

describe("MasterDetail — resizable rail (#2209)", () => {
  it("renders a splitter and starts the rail at railWidth", () => {
    const { container } = render(
      <MasterDetail resizable railWidth={220} railMin={160} railMax={460}
        rail={<span>RAIL</span>} detail={<span>DETAIL</span>} />,
    );
    expect(container.querySelector(".resize-x")).not.toBeNull();
    const railBox = screen.getByText("RAIL").parentElement as HTMLElement;
    expect(railBox.style.width).toBe("220px");
  });

  it("grows the rail when the splitter is dragged, clamped to railMax", () => {
    const { container } = render(
      <MasterDetail resizable railWidth={220} railMin={160} railMax={460}
        rail={<span>RAIL</span>} detail={<span>DETAIL</span>} />,
    );
    const handle = container.querySelector(".resize-x") as HTMLElement;
    const railBox = screen.getByText("RAIL").parentElement as HTMLElement;

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 40, pointerId: 1 });
    expect(railBox.style.width).toBe("260px"); // 220 + 40

    // Past the max is clamped.
    fireEvent.pointerMove(handle, { clientX: 999, pointerId: 1 });
    expect(railBox.style.width).toBe("460px");
    fireEvent.pointerUp(handle, { clientX: 999, pointerId: 1 });
  });
});
