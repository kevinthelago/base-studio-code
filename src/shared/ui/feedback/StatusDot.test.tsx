import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatusDot } from "./StatusDot";

describe("StatusDot", () => {
  const dot = (c: HTMLElement) => c.querySelector("span") as HTMLSpanElement;

  it("defaults to currentColor and a 6px circle", () => {
    const { container } = render(<StatusDot />);
    const s = dot(container);
    expect(s.style.background.toLowerCase()).toBe("currentcolor");
    expect(s.style.width).toBe("6px");
    expect(s.style.height).toBe("6px");
    expect(s.style.borderRadius).toBe("50%");
    expect(s.getAttribute("aria-hidden")).toBe("true");
  });

  it("maps a semantic state to its --state-* token", () => {
    expect(dot(render(<StatusDot state="run" />).container).style.background).toBe("var(--state-run)");
    expect(dot(render(<StatusDot state="wait" />).container).style.background).toBe("var(--state-wait)");
    expect(dot(render(<StatusDot state="idle" />).container).style.background).toBe("var(--state-idle)");
    expect(dot(render(<StatusDot state="stopped" />).container).style.background).toBe("var(--state-stopped)");
  });

  it("an explicit color overrides state", () => {
    const s = dot(render(<StatusDot state="run" color="var(--danger)" />).container);
    expect(s.style.background).toBe("var(--danger)");
  });

  it("honors size and applies a pulse animation when asked", () => {
    const s = dot(render(<StatusDot size={9} pulse />).container);
    expect(s.style.width).toBe("9px");
    expect(s.style.animation).toContain("pulse");
  });

  it("exposes a title (and drops aria-hidden) when given", () => {
    const s = dot(render(<StatusDot title="running" />).container);
    expect(s.getAttribute("title")).toBe("running");
    expect(s.getAttribute("aria-hidden")).toBeNull();
  });
});
