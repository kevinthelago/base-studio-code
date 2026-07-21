import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AnimationsMenu } from "./AnimationsMenu";
import type { KitAnimation } from "@/shared/ui/kit";

// The component's motion presented as PRESETS (#3083) — composed alternatives sharing the `motion`
// group, one marked default (the active one). Distinct names from SHELF so the two groups never collide
// under getByText.
const PRESETS: KitAnimation[] = [
  { name: "slide-grow-in", group: "motion", default: true, keyframes: { from: { opacity: "0" }, to: { opacity: "1" } }, trigger: "mount" },
  { name: "fade-in", group: "motion", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } }, trigger: "mount" },
];
// The kit's reusable shelf (the secondary/generic group).
const SHELF: KitAnimation[] = [
  { name: "fade", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } }, trigger: "mount" },
  { name: "lift", keyframes: { from: { transform: "translateY(0)" }, to: { transform: "translateY(-1px)" } }, trigger: "hover" },
];

describe("AnimationsMenu (#3083 — presets)", () => {
  it("presents the component's motion as a PICK-ONE list of presets", () => {
    render(<AnimationsMenu componentAnimations={PRESETS} shelf={[]} boundShelfNames={[]} activeName={null} onPlay={() => {}} />);
    expect(screen.getByText(/Presets/i)).toBeInTheDocument();
    expect(screen.getByText("slide-grow-in")).toBeInTheDocument();
    expect(screen.getByText("fade-in")).toBeInTheDocument();
  });

  it("marks the ACTIVE preset — the default, else the first — and only it", () => {
    render(<AnimationsMenu componentAnimations={PRESETS} shelf={[]} boundShelfNames={[]} activeName={null} onPlay={() => {}} />);
    expect(screen.getByText("slide-grow-in").closest("[data-anim-name]")!.textContent).toContain("active");
    expect(screen.getByText("fade-in").closest("[data-anim-name]")!.textContent).not.toContain("active");
  });

  it("falls back to the FIRST preset as active when none is marked default (legacy ungrouped)", () => {
    const ungrouped: KitAnimation[] = [
      { name: "a", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } } },
      { name: "b", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } } },
    ];
    render(<AnimationsMenu componentAnimations={ungrouped} shelf={[]} boundShelfNames={[]} activeName={null} onPlay={() => {}} />);
    expect(screen.getByText("a").closest("[data-anim-name]")!.textContent).toContain("active");
    expect(screen.getByText("b").closest("[data-anim-name]")!.textContent).not.toContain("active");
  });

  it("clicking a preset selects it as the component's motion (#3083)", () => {
    const onSelectPreset = vi.fn();
    render(<AnimationsMenu componentAnimations={PRESETS} shelf={[]} boundShelfNames={[]} activeName={null} onPlay={() => {}} onSelectPreset={onSelectPreset} />);
    fireEvent.click(screen.getByText("fade-in"));
    expect(onSelectPreset).toHaveBeenCalledWith("fade-in");
  });

  it("shows a muted hint when the component has no animations of its own", () => {
    render(<AnimationsMenu componentAnimations={[]} shelf={SHELF} boundShelfNames={[]} activeName={null} onPlay={() => {}} />);
    expect(screen.getByText(/No animations on this component/i)).toBeInTheDocument();
  });

  it("renders the shelf only when non-empty, marks referenced names, and plays on click", () => {
    const onPlay = vi.fn();
    const { rerender } = render(
      <AnimationsMenu componentAnimations={PRESETS} shelf={[]} boundShelfNames={[]} activeName={null} onPlay={onPlay} />,
    );
    // no shelf → no shelf rows / header
    expect(screen.queryByText("fade")).not.toBeInTheDocument();
    expect(screen.queryByText(/Generic shelf/i)).not.toBeInTheDocument();
    // with a shelf, its rows appear; the referenced one carries the ● marker, the other does not
    rerender(<AnimationsMenu componentAnimations={PRESETS} shelf={SHELF} boundShelfNames={["lift"]} activeName={null} onPlay={onPlay} />);
    expect(screen.getByText(/Generic shelf/i)).toBeInTheDocument();
    expect(screen.getByText("lift").closest("[data-anim-name]")!.textContent).toContain("●");
    expect(screen.getByText("fade").closest("[data-anim-name]")!.textContent).not.toContain("●");
    // a shelf row plays on the vehicle (try-on)
    fireEvent.click(screen.getByText("fade"));
    expect(onPlay).toHaveBeenCalledWith("fade");
    // once a shelf row is the active try-on, clicking it again clears (null)
    rerender(<AnimationsMenu componentAnimations={PRESETS} shelf={SHELF} boundShelfNames={[]} activeName="fade" onPlay={onPlay} />);
    fireEvent.click(screen.getByText("fade"));
    expect(onPlay).toHaveBeenLastCalledWith(null);
  });
});
