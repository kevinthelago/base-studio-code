import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import { GraphComponent } from "./GraphComponent";
import { resetLastGood } from "./renderGate";

// The loader is mocked: compiling real source needs esbuild, and what this file is about is the GATE —
// which version gets mounted when a compile or a render fails — not the compiler.
const load = vi.hoisted(() => vi.fn());
vi.mock("./componentLoader", () => ({ loadComponentFromSource: load }));
vi.mock("./graphResolver", () => ({ resolveGraphSource: () => null }));

const GOOD = "export default () => 'GOOD';";
const NEXT = "export default () => 'NEXT';";

/** Point the store's record at `srcText`. */
function setSource(srcText: string) {
  useAppStore.setState({ components: [{ id: "x", srcText }] as never });
}

describe("GraphComponent render gate (#graph-render-gate)", () => {
  beforeEach(() => {
    resetLastGood();
    load.mockReset();
    useAppStore.setState({ components: [] as never });
  });

  it("mounts the component and remembers it as the last version that WORKED", async () => {
    load.mockResolvedValue(() => <div>good</div>);
    setSource(GOOD);
    render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();
  });

  it("falls back to the last WORKING version when the new source fails to COMPILE", async () => {
    // 1) a version that works — this is what the gate must remember
    load.mockResolvedValueOnce(() => <div>good</div>);
    setSource(GOOD);
    const view = render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();

    // 2) the record is edited to something that will not compile
    load.mockRejectedValueOnce(new Error("Unexpected token"));
    setSource(NEXT);
    view.rerender(<GraphComponent id="x" fallback={<div>fallback</div>} />);

    // the previous working version is mounted — NOT the empty fallback
    await waitFor(() => expect(screen.getByText("good")).toBeTruthy());
    expect(screen.queryByText("fallback")).toBeNull();
  });

  it("shows the caller's fallback when a compile fails and NOTHING has worked yet", async () => {
    // No known-good version ⇒ unchanged behaviour. The gate must never invent a component.
    load.mockRejectedValue(new Error("Unexpected token"));
    setSource(NEXT);
    render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("fallback")).toBeTruthy();
  });

  it("does not mark a version good just because a FALLBACK rendered under it", async () => {
    // The trap: after a degraded mount the good component is on screen while the store still holds the
    // BROKEN source. If the marking effect keyed on the record's source it would file the broken one as
    // good, and the next failure would have nothing to fall back to.
    load.mockResolvedValueOnce(() => <div>good</div>);
    setSource(GOOD);
    const view = render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();

    load.mockRejectedValueOnce(new Error("boom"));
    setSource(NEXT);
    view.rerender(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    await waitFor(() => expect(screen.getByText("good")).toBeTruthy());

    // a THIRD source also fails — the good version must still be the one from step 1
    load.mockRejectedValueOnce(new Error("boom again"));
    setSource("export default () => 'THIRD';");
    view.rerender(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    await waitFor(() => expect(screen.getByText("good")).toBeTruthy());
  });
});
