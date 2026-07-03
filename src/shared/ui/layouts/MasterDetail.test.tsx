// MasterDetail (#2197/#2198) — the standardized list+detail page skeleton: rail + detail slots, an
// optional toolbar above, and a fixed railWidth owned by the template.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
