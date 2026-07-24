import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GraphPageFallback } from "./GraphPageFallback";
import { useAppStore } from "@/store";

const realHydrate = useAppStore.getState().hydrateComponents;
afterEach(() => useAppStore.setState({ hydrateComponents: realHydrate }));

describe("GraphPageFallback (#3648/#3652)", () => {
  it("renders the page-named notice + both recoveries (reliable Reload + in-place Re-seed)", () => {
    render(<GraphPageFallback page="GitHub" />);
    expect(screen.getByText("GitHub page unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload to apply/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /re-seed in place/i })).toBeInTheDocument();
  });

  it("clicking Reload triggers a window reload (the reliable apply)", () => {
    const reload = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...orig, reload } });
    render(<GraphPageFallback page="GitHub" />);
    fireEvent.click(screen.getByRole("button", { name: /reload to apply/i }));
    expect(reload).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, "location", { configurable: true, value: orig });
  });

  it("clicking Re-seed calls hydrateComponents and swaps to the seeded state (Reload hint)", async () => {
    const hydrate = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ hydrateComponents: hydrate });
    render(<GraphPageFallback page="Automations" />);
    fireEvent.click(screen.getByRole("button", { name: /re-seed in place/i }));
    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/re-seeded the library in place/i)).toBeInTheDocument());
    // Reload stays available as the reliable path even after an in-place re-seed.
    expect(screen.getByRole("button", { name: /reload to apply/i })).toBeInTheDocument();
  });

  it("surfaces a re-seed failure without throwing", async () => {
    const hydrate = vi.fn().mockRejectedValue(new Error("bridge down"));
    useAppStore.setState({ hydrateComponents: hydrate });
    render(<GraphPageFallback page="Fleet" />);
    fireEvent.click(screen.getByRole("button", { name: /re-seed in place/i }));
    await waitFor(() => expect(screen.getByText(/re-seed failed/i)).toBeInTheDocument());
  });
});
