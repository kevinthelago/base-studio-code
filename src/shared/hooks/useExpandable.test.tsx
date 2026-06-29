import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useExpandable } from "./useExpandable";

function Harness() {
  const { isOpen, toggle } = useExpandable(["a"]);
  return (
    <div>
      <span data-testid="a">{isOpen("a") ? "open" : "closed"}</span>
      <span data-testid="b">{isOpen("b") ? "open" : "closed"}</span>
      <button onClick={() => toggle("b")}>tb</button>
      <button onClick={() => toggle("a")}>ta</button>
    </div>
  );
}

describe("useExpandable", () => {
  it("seeds from the initial set, toggles membership, and reports isOpen", () => {
    render(<Harness />);
    expect(screen.getByTestId("a").textContent).toBe("open");
    expect(screen.getByTestId("b").textContent).toBe("closed");
    fireEvent.click(screen.getByText("tb"));
    expect(screen.getByTestId("b").textContent).toBe("open");
    fireEvent.click(screen.getByText("ta"));
    expect(screen.getByTestId("a").textContent).toBe("closed");
  });
});
