import { describe, it, expect, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { LiveRegion } from "./LiveRegion";
import { useAnnouncer, announce } from "@/shared/lib/a11y/announcer";

describe("LiveRegion (#3770)", () => {
  beforeEach(() => {
    cleanup();
    useAnnouncer.setState({ polite: "", assertive: "", politeSeq: 0, assertiveSeq: 0 });
  });

  it("renders a polite + an assertive live region, both visually hidden", () => {
    const { container } = render(<LiveRegion />);
    expect(container.querySelectorAll(".sr-only")).toHaveLength(2);
    expect(container.querySelector('[aria-live="polite"][aria-atomic="true"]')).toBeTruthy();
    // The assertive region is a role=alert so it interrupts.
    expect(container.querySelector('[role="alert"][aria-live="assertive"]')).toBeTruthy();
  });

  it("reflects an announced polite message into the polite region", () => {
    const { container } = render(<LiveRegion />);
    act(() => announce("api-stream paused and is waiting for you"));
    expect(container.querySelector('[aria-live="polite"]')?.textContent)
      .toContain("api-stream paused and is waiting for you");
  });

  it("routes an assertive announcement into the alert region, not the polite one", () => {
    const { container } = render(<LiveRegion />);
    act(() => announce("a dependency chain failed", { assertive: true }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("a dependency chain failed");
    expect(container.querySelector('[aria-live="polite"]')?.textContent?.trim()).toBe("");
  });
});
