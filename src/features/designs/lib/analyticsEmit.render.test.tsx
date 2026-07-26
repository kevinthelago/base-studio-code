import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KitRenderer, type GeneralNode } from "@/shared/ui/spec";
import { makeAnalyticsEmit, componentAnalyticsLookup, collectingSink } from "./analyticsEmit";

// The end-to-end proof: a spec composed from an INSTRUMENTED component auto-emits its declared event when
// the action fires — through the SAME renderer studio pages + generated specs use. Nothing in the spec
// says "record"; emission is derived from the manifest at the render seam (#3816, epic #3809 slice 3).

const buttonSpec: GeneralNode = {
  type: "Button",
  props: { children: "Go" },
  actions: { onClick: "go" },
};

const lookup = componentAnalyticsLookup([
  { name: "Button", analytics: [{ event: "click", props: [{ name: "label", type: "string", req: false, desc: "" }] }] },
]);

describe("KitRenderer analytics emit seam", () => {
  it("records the declared event when the action fires, and still dispatches the handler", () => {
    const go = vi.fn();
    const sink = collectingSink();
    render(<KitRenderer node={buttonSpec} on={{ go }} emit={makeAnalyticsEmit(lookup, sink)} />);

    fireEvent.click(screen.getByText("Go"));

    // Dispatch to the host callback is unaffected.
    expect(go).toHaveBeenCalledTimes(1);
    // And the manifest-driven event was recorded. A click's MouseEvent carries no analytics payload, so
    // props is empty — the runtime records the event name without fabricating a payload it cannot see.
    expect(sink.records).toEqual([{ event: "click", props: {} }]);
  });

  it("is inert with no emit hook — the default render path is unchanged", () => {
    const go = vi.fn();
    render(<KitRenderer node={buttonSpec} on={{ go }} />);
    expect(() => fireEvent.click(screen.getByText("Go"))).not.toThrow();
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("does not record when the component declares no matching event", () => {
    const go = vi.fn();
    const sink = collectingSink();
    // A lookup with no `click` event for Button → the fire resolves to nothing.
    const emptyLookup = componentAnalyticsLookup([{ name: "Button" }]);
    render(<KitRenderer node={buttonSpec} on={{ go }} emit={makeAnalyticsEmit(emptyLookup, sink)} />);

    fireEvent.click(screen.getByText("Go"));

    expect(go).toHaveBeenCalledTimes(1);
    expect(sink.records).toEqual([]);
  });
});
