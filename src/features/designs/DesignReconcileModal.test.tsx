import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Isolate the modal from the generator + logger.
vi.mock("./lib/designGenBridge", () => ({ generateCategoryColors: vi.fn() }));
vi.mock("@/shared/lib/core/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { generateCategoryColors } from "./lib/designGenBridge";
import { log } from "@/shared/lib/core/log";
import { useAppStore } from "@/store";
import { DesignReconcileModal } from "./DesignReconcileModal";

describe("DesignReconcileModal (#2658)", () => {
  beforeEach(() => {
    vi.mocked(generateCategoryColors).mockReset();
    vi.mocked(log.warn).mockReset();
    useAppStore.setState({ designContributions: [] });
    document.getElementById("bsc-ui-contributions")?.remove();
  });

  it("lists the missing categories + the preferred theme ref", () => {
    render(<DesignReconcileModal source="bp-1" label="CAD Studio" missingCategories={["simulation", "analysis"]} themeRef="warm" onClose={vi.fn()} />);
    expect(screen.getByText("simulation")).toBeTruthy();
    expect(screen.getByText("analysis")).toBeTruthy();
    expect(screen.getByText("CAD Studio")).toBeTruthy();
    expect(screen.getByText("warm")).toBeTruthy();
  });

  it("generate & apply registers a contribution keyed by source, then closes", async () => {
    vi.mocked(generateCategoryColors).mockResolvedValueOnce({ simulation: "#123456" });
    const onClose = vi.fn();
    render(<DesignReconcileModal source="bp-1" label="CAD" missingCategories={["simulation"]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const contribs = useAppStore.getState().designContributions;
    expect(contribs).toHaveLength(1);
    expect(contribs[0]).toEqual({ source: "bp-1", tokens: { "--graph-category-simulation": "#123456" } });
    // …and it went live on :root (compose-don't-mutate overlay).
    expect(document.getElementById("bsc-ui-contributions")?.textContent).toContain("--graph-category-simulation: #123456;");
  });

  it("falls LOUDLY on a generator failure — shows an error banner, does NOT close or contribute", async () => {
    vi.mocked(generateCategoryColors).mockRejectedValueOnce(new Error("bsc unavailable"));
    const onClose = vi.fn();
    render(<DesignReconcileModal source="bp-1" label="CAD" missingCategories={["simulation"]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/bsc unavailable/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(useAppStore.getState().designContributions).toHaveLength(0);
  });

  it("skip closes without contributing, and records a loud warn (the gap stays observable)", () => {
    const onClose = vi.fn();
    render(<DesignReconcileModal source="bp-1" label="CAD" missingCategories={["simulation"]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    expect(onClose).toHaveBeenCalled();
    expect(useAppStore.getState().designContributions).toHaveLength(0);
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
    expect(vi.mocked(generateCategoryColors)).not.toHaveBeenCalled();
  });
});
