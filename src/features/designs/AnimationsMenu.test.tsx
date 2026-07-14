import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AnimationsMenu } from "./AnimationsMenu";
import type { KitAnimation } from "@/shared/ui/kit";

// The component's OWN motion (the primary group — what actually plays on it).
const OWN: KitAnimation[] = [
  { name: "draw-in", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } }, trigger: "mount" },
];
// The kit's reusable shelf (the secondary/generic group). Distinct names from OWN so the two groups
// never collide under getByText.
const SHELF: KitAnimation[] = [
  { name: "fade", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } }, trigger: "mount" },
  { name: "lift", keyframes: { from: { transform: "translateY(0)" }, to: { transform: "translateY(-1px)" } }, trigger: "hover" },
];

describe("AnimationsMenu (#3067)", () => {
  it("leads with the component's OWN animations (one row each) under the primary group", () => {
    render(<AnimationsMenu componentAnimations={OWN} shelf={[]} boundShelfNames={[]} activeName={null} onPlay={() => {}} />);
    expect(screen.getByText(/This component/i)).toBeInTheDocument();
    expect(screen.getByText("draw-in")).toBeInTheDocument();
  });

  it("shows a muted hint when the component has no animations of its own", () => {
    render(<AnimationsMenu componentAnimations={[]} shelf={SHELF} boundShelfNames={[]} activeName={null} onPlay={() => {}} />);
    expect(screen.getByText(/No animations on this component/i)).toBeInTheDocument();
  });

  it("renders the shelf only when non-empty, marking the names the component references", () => {
    const { rerender } = render(
      <AnimationsMenu componentAnimations={OWN} shelf={[]} boundShelfNames={[]} activeName={null} onPlay={() => {}} />,
    );
    // no shelf → no shelf rows / header
    expect(screen.queryByText("fade")).not.toBeInTheDocument();
    expect(screen.queryByText(/Generic shelf/i)).not.toBeInTheDocument();
    // with a shelf, its rows appear; the referenced one carries the ● marker, the other does not
    rerender(<AnimationsMenu componentAnimations={OWN} shelf={SHELF} boundShelfNames={["lift"]} activeName={null} onPlay={() => {}} />);
    expect(screen.getByText(/Generic shelf/i)).toBeInTheDocument();
    expect(screen.getByText("fade")).toBeInTheDocument();
    expect(screen.getByText("lift")).toBeInTheDocument();
    expect(screen.getByText("lift").closest("[data-anim-name]")!.textContent).toContain("●");
    expect(screen.getByText("fade").closest("[data-anim-name]")!.textContent).not.toContain("●");
  });

  it("plays a motion on click (both groups), and clears when the active row is clicked again", () => {
    const onPlay = vi.fn();
    const { rerender } = render(
      <AnimationsMenu componentAnimations={OWN} shelf={SHELF} boundShelfNames={[]} activeName={null} onPlay={onPlay} />,
    );
    // a primary-group (own) row plays
    fireEvent.click(screen.getByText("draw-in"));
    expect(onPlay).toHaveBeenCalledWith("draw-in");
    // a shelf-group row plays too
    fireEvent.click(screen.getByText("fade"));
    expect(onPlay).toHaveBeenLastCalledWith("fade");
    // once a row is the active try-on, clicking it again clears (null)
    rerender(<AnimationsMenu componentAnimations={OWN} shelf={SHELF} boundShelfNames={[]} activeName="draw-in" onPlay={onPlay} />);
    fireEvent.click(screen.getByText("draw-in"));
    expect(onPlay).toHaveBeenLastCalledWith(null);
  });
});
