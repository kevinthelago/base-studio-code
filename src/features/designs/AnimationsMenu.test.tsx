import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AnimationsMenu } from "./AnimationsMenu";
import type { KitAnimation } from "@/shared/ui/kit";

const ANIMS: KitAnimation[] = [
  { name: "fade-in", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } }, trigger: "mount" },
  { name: "lift", keyframes: { from: { transform: "translateY(0)" }, to: { transform: "translateY(-1px)" } }, trigger: "hover" },
];

describe("AnimationsMenu (#2942)", () => {
  it("lists the kit's animations, marking the ones this component binds", () => {
    render(<AnimationsMenu animations={ANIMS} boundNames={["lift"]} activeName={null} onPlay={() => {}} />);
    expect(screen.getByText("fade-in")).toBeInTheDocument();
    expect(screen.getByText("lift")).toBeInTheDocument();
    // the bound row (lift) carries the ● marker; the unbound one (fade-in) does not
    expect(screen.getByText("lift").closest("[data-anim-name]")!.textContent).toContain("●");
    expect(screen.getByText("fade-in").closest("[data-anim-name]")!.textContent).not.toContain("●");
  });

  it("plays a motion on click, and clears when the active row is clicked again", () => {
    const onPlay = vi.fn();
    const { rerender } = render(<AnimationsMenu animations={ANIMS} boundNames={[]} activeName={null} onPlay={onPlay} />);
    fireEvent.click(screen.getByText("fade-in"));
    expect(onPlay).toHaveBeenCalledWith("fade-in");
    // once it's the active try-on, clicking it again clears (null)
    rerender(<AnimationsMenu animations={ANIMS} boundNames={[]} activeName="fade-in" onPlay={onPlay} />);
    fireEvent.click(screen.getByText("fade-in"));
    expect(onPlay).toHaveBeenLastCalledWith(null);
  });

  it("shows an empty state when the kit has no motion", () => {
    render(<AnimationsMenu animations={[]} boundNames={[]} activeName={null} onPlay={() => {}} />);
    expect(screen.getByText(/No motion/i)).toBeInTheDocument();
  });
});
