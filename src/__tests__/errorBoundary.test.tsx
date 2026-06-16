import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary";

function Boom({ explode }: { explode: boolean }): React.ReactElement {
  if (explode) throw new Error("kaboom");
  return <div>alive</div>;
}

describe("ErrorBoundary", () => {
  // React logs caught render errors to console.error; silence it for clean output.
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("renders children when nothing throws", () => {
    render(<ErrorBoundary><div>hello</div></ErrorBoundary>);
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("catches a render error and shows a recoverable fallback (app stays up)", () => {
    render(<ErrorBoundary label="this view"><Boom explode /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Something went wrong in this view/)).toBeTruthy();
    expect(screen.getByText("kaboom")).toBeTruthy();
  });

  it("'try again' clears the error and re-renders the children", () => {
    function Harness() {
      const [explode, setExplode] = useState(true);
      return (
        <>
          <button onClick={() => setExplode(false)}>fix</button>
          <ErrorBoundary><Boom explode={explode} /></ErrorBoundary>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByRole("alert")).toBeTruthy();
    // Fix the underlying cause, then reset the boundary.
    fireEvent.click(screen.getByText("fix"));
    fireEvent.click(screen.getByText("try again"));
    expect(screen.getByText("alive")).toBeTruthy();
  });

  it("auto-recovers when resetKeys change (e.g. navigation)", () => {
    function Harness() {
      const [screenKey, setScreenKey] = useState("a");
      const [explode, setExplode] = useState(true);
      return (
        <>
          <button onClick={() => { setExplode(false); setScreenKey("b"); }}>nav</button>
          <ErrorBoundary resetKeys={[screenKey]}><Boom explode={explode} /></ErrorBoundary>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByText("nav"));
    expect(screen.getByText("alive")).toBeTruthy();
  });
});
