import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FillBar } from "./FillBar";

describe("FillBar", () => {
  it("renders a track with an inner fill at value%", () => {
    const { container } = render(<FillBar value={0.4} color="var(--info)" />);
    const track = container.firstChild as HTMLElement;
    const fill = track.firstChild as HTMLElement;
    expect(track.style.background).toBe("var(--bg-elev2)");
    expect(track.style.overflow).toBe("hidden");
    expect(fill.style.width).toBe("40%");
    expect(fill.style.background).toBe("var(--info)");
  });

  it("clamps value to [0,1]", () => {
    const { container } = render(<FillBar value={1.8} />);
    const fill = (container.firstChild as HTMLElement).firstChild as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("renders square corners when rounded={false}", () => {
    const { container } = render(<FillBar value={0.5} rounded={false} />);
    const track = container.firstChild as HTMLElement;
    expect(track.style.borderRadius).toBe("0px");
  });
});
