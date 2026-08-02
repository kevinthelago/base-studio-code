import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlannerLibraryPane } from "./PlannerLibraryPane";
import { FeaturesStageBody } from "./FeaturesStageBody";
import { useAppStore } from "@/store";
import blueprintDefault from "@data/blueprints/default.json";

// The two library lenses are heavy (one assembles specimens, the other polls `bsc graph dump`), and
// neither's internals are what this file is about — it asserts that the planner PRESENTS both.
vi.mock("@/features/designs", () => ({
  PlannerComponentsPane: () => <div data-testid="components-pane" />,
}));
vi.mock("@/features/algorithms", () => ({
  PlannerAlgorithmsPane: () => <div data-testid="algorithms-pane" />,
}));

beforeEach(() => {
  useAppStore.setState({ components: [], kits: [] });
});

describe("PlannerLibraryPane (#4265)", () => {
  it("presents BOTH libraries — components and algorithms — from one dock", () => {
    render(<PlannerLibraryPane />);
    expect(screen.getByRole("button", { name: "Components" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Algorithms" })).toBeInTheDocument();
  });

  it("opens on components and switches to algorithms", () => {
    render(<PlannerLibraryPane />);
    // Additive by default: whoever knew where the kit lens lived still lands on it.
    expect(screen.getByTestId("components-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("algorithms-pane")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Algorithms" }));
    expect(screen.getByTestId("algorithms-pane")).toBeInTheDocument();
    // Only the active half mounts — the inactive one must not keep polling behind it.
    expect(screen.queryByTestId("components-pane")).not.toBeInTheDocument();
  });

  it("can open directly on algorithms", () => {
    render(<PlannerLibraryPane initial="algorithms" />);
    expect(screen.getByTestId("algorithms-pane")).toBeInTheDocument();
  });
});

describe("FeaturesStageBody — where the library is reachable from (#4265)", () => {
  it("opens on the plan, with the library one click away", () => {
    render(<FeaturesStageBody features={[]} />);
    expect(screen.getByRole("button", { name: "Features" })).toBeInTheDocument();
    // The library is the reference you reach for, not the default view.
    expect(screen.queryByTestId("components-pane")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(screen.getByTestId("components-pane")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Algorithms" })).toBeInTheDocument();
  });

  it("hangs off a stage every packaged blueprint carries — the orphaning guard", () => {
    // THE regression this file exists for. The components lens used to hang off `test_ui`, which #4249
    // retired and no blueprint carries, so it was unreachable and nobody noticed. Asserting the host
    // stage is in the packaged route makes "the library is reachable" a checked property rather than
    // an assumption — if a future reshape drops `features`, this fails instead of silently orphaning
    // both lenses again.
    const keys = (blueprintDefault.sections ?? []).map((s: { key: string }) => s.key);
    expect(keys).toContain("features");
    expect(keys).not.toContain("test_ui");
  });
});
