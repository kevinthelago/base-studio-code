import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConsolePageCard } from "./ConsolePageCard";
import { useAppStore } from "@/store";

describe("ConsolePageCard", () => {
  beforeEach(() => useAppStore.setState({ showConsolePage: false }));

  it("toggles the legacy console page on (off by default, #2372)", () => {
    render(<ConsolePageCard />);
    expect(screen.getByText(/Show the legacy Console page/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    expect(useAppStore.getState().showConsolePage).toBe(true);
  });
});
