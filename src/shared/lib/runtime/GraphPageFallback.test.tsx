import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GraphPageFallback } from "./GraphPageFallback";
import { useAppStore } from "@/store";

const realHydrate = useAppStore.getState().hydrateComponents;
afterEach(() => useAppStore.setState({ hydrateComponents: realHydrate }));

describe("GraphPageFallback (#3648)", () => {
  it("renders the page-named unavailable notice + a re-seed CTA", () => {
    render(<GraphPageFallback page="Security" />);
    expect(screen.getByText("Security page unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /re-seed component library/i })).toBeInTheDocument();
  });

  it("clicking re-seed calls hydrateComponents and swaps to the done state (reload hint)", async () => {
    const hydrate = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ hydrateComponents: hydrate });
    render(<GraphPageFallback page="Automations" />);
    fireEvent.click(screen.getByRole("button", { name: /re-seed component library/i }));
    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
    // On success the CTA is replaced by guidance (the source-present case re-renders into the page upstream).
    await waitFor(() => expect(screen.getByText(/reload the window/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /re-seed component library/i })).toBeNull();
  });

  it("surfaces a re-seed failure without throwing", async () => {
    const hydrate = vi.fn().mockRejectedValue(new Error("bridge down"));
    useAppStore.setState({ hydrateComponents: hydrate });
    render(<GraphPageFallback page="Fleet" />);
    fireEvent.click(screen.getByRole("button", { name: /re-seed component library/i }));
    await waitFor(() => expect(screen.getByText(/re-seed failed/i)).toBeInTheDocument());
  });
});
