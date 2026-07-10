import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { renderHook, act } from "@testing-library/react";
import { RailSection } from "./RailSection";
import { useRailSections } from "@/shared/hooks/useRailSections";

describe("RailSection (#2797)", () => {
  it("shows its rows only when open", () => {
    const { rerender } = render(
      <RailSection label="Structures" count={2} open onToggle={() => {}}>
        <div>Stack</div>
      </RailSection>,
    );
    expect(screen.getByText("Structures")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Stack")).toBeTruthy();
    rerender(
      <RailSection label="Structures" count={2} open={false} onToggle={() => {}}>
        <div>Stack</div>
      </RailSection>,
    );
    expect(screen.queryByText("Stack")).toBeNull(); // collapsed → rows hidden
  });

  it("fires onToggle when the header is clicked", () => {
    const onToggle = vi.fn();
    render(<RailSection label="Algorithms" open onToggle={onToggle}><div>row</div></RailSection>);
    fireEvent.click(screen.getByText("Algorithms"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("useRailSections (#2797)", () => {
  it("defaults sections open and flips them on toggle", () => {
    const { result } = renderHook(() => useRailSections());
    expect(result.current.isOpen("a")).toBe(true); // default open
    act(() => result.current.toggle("a"));
    expect(result.current.isOpen("a")).toBe(false);
    expect(result.current.isOpen("b")).toBe(true); // untouched keys stay at the default
    act(() => result.current.toggle("a"));
    expect(result.current.isOpen("a")).toBe(true);
  });

  it("honors a default-closed start", () => {
    const { result } = renderHook(() => useRailSections(false));
    expect(result.current.isOpen("x")).toBe(false);
    act(() => result.current.toggle("x"));
    expect(result.current.isOpen("x")).toBe(true);
  });
});
