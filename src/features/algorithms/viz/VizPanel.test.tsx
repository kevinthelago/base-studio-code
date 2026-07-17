// VizStage (#3205) — the in-canvas visualization take-over rendered in GraphCanvas's overlays slot: a
// large player with controls + the editable "your input" field, and a ← Back to graph bar. (Cell counts
// track the input length, which is invariant across sort frames, so they're timing-independent.)
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { VizStage } from "./VizPanel";
import { programVizForImpl } from "./examples/registry";

const viz = programVizForImpl({ id: "sort.ts", name: "sort" })!; // the array-sort visualization (insertion program)

describe("VizStage — in-canvas take-over (#3205)", () => {
  it("renders a full player with controls + the seeded input, over the canvas", () => {
    render(<VizStage viz={viz} implName="sort" onBack={() => {}} />);
    const stage = screen.getByRole("group", { name: /Visualization — sort/ });
    // Full transport (unlike the inline preview).
    expect(within(stage).getByLabelText("Step forward")).toBeTruthy();
    // Frame 0 of the default renders the 9 mock cells.
    expect(stage.querySelector(".algo-viz-stage-body")!.querySelectorAll(".array-cell").length).toBe(9);
    // The editable field is seeded with the example default.
    expect((within(stage).getByRole("textbox") as HTMLInputElement).value).toBe("5, 2, 9, 1, 6, 3, 8, 4, 7");
  });

  it("Run re-runs the trace on the user's own input", async () => {
    render(<VizStage viz={viz} implName="sort" onBack={() => {}} />);
    const stage = screen.getByRole("group", { name: /Visualization — sort/ });
    fireEvent.change(within(stage).getByRole("textbox"), { target: { value: "3, 1, 2" } });
    fireEvent.click(within(stage).getByRole("button", { name: "Run" }));
    // make() is async now (#3233) — the custom 3-element input renders a 3-cell trace once it resolves.
    await waitFor(() => expect(stage.querySelector(".algo-viz-stage-body")!.querySelectorAll(".array-cell").length).toBe(3));
  });

  it("invalid input surfaces an error and keeps the last good run", async () => {
    render(<VizStage viz={viz} implName="sort" onBack={() => {}} />);
    const stage = screen.getByRole("group", { name: /Visualization — sort/ });
    const body = stage.querySelector(".algo-viz-stage-body")!;
    const before = body.querySelectorAll(".array-cell").length; // the default 9-cell run
    fireEvent.change(within(stage).getByRole("textbox"), { target: { value: "abc" } });
    fireEvent.click(within(stage).getByRole("button", { name: "Run" }));
    // parse() throws synchronously, so make() is never reached — the prior run stays.
    expect(await within(stage).findByText(/is not a number/i)).toBeTruthy();
    expect(body.querySelectorAll(".array-cell").length).toBe(before); // prior run untouched
  });

  it("← Back to graph calls onBack", () => {
    const onBack = vi.fn();
    render(<VizStage viz={viz} implName="sort" onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: /back to graph/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
