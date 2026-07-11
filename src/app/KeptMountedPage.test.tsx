// KeptMountedPage (#2827) — the lazy-mount + kept-mounted (CSS-hidden) idiom. These tests pin the
// exact contract the docked-session Planner tabs depend on (Planning, Designs, and Algorithms): a page
// mounts on first activation, then STAYS mounted (toggled with `display`) when it goes inactive, so its
// live PTY survives a tab switch instead of being torn down — the Algorithms Librarian regression (#2827).
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { KeptMountedPage } from "./KeptMountedPage";

describe("KeptMountedPage", () => {
  it("does not mount its children until first activated", () => {
    const { queryByTestId } = render(
      <KeptMountedPage active={false}><div data-testid="child" /></KeptMountedPage>,
    );
    expect(queryByTestId("child")).toBeNull();
  });

  it("keeps children MOUNTED (hidden) after going inactive — the PTY-survival contract", () => {
    // First activation latches the page; a later inactive render must keep it in the DOM (display:none),
    // NOT unmount it — unmounting is what killed + relaunched the Algorithms Librarian session (#2827).
    const { queryByTestId, rerender, container } = render(
      <KeptMountedPage active={true}><div data-testid="child" /></KeptMountedPage>,
    );
    expect(queryByTestId("child")).not.toBeNull();
    expect((container.firstElementChild as HTMLElement).style.display).toBe("flex");

    rerender(<KeptMountedPage active={false}><div data-testid="child" /></KeptMountedPage>);
    // Still in the DOM (the session survives), just hidden.
    expect(queryByTestId("child")).not.toBeNull();
    expect((container.firstElementChild as HTMLElement).style.display).toBe("none");
  });

  it("unmounts when the single-owner gate drops (tear-off), even once shown", () => {
    // The tear-off release: while the gate is false the page never latches and unmounts if already
    // shown, so the detached window becomes the SOLE owner of the single PTY (no double pty_create).
    const { queryByTestId, rerender } = render(
      <KeptMountedPage active={true} gate={true}><div data-testid="child" /></KeptMountedPage>,
    );
    expect(queryByTestId("child")).not.toBeNull();

    rerender(<KeptMountedPage active={true} gate={false}><div data-testid="child" /></KeptMountedPage>);
    expect(queryByTestId("child")).toBeNull();
  });
});
