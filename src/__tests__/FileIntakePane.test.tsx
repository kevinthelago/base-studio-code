import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { FileIntakePane } from "../screens/planner/bodies/FileIntakePane";
import { ROUTE_PROMPT } from "../screens/planner/shared/fileIntake";
import { useAppStore } from "../store";

describe("FileIntakePane (#604)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useAppStore.setState({ pendingPlannerPrompt: {}, planConfirmedSections: {} });
  });

  it("renders the drop zone and a folder picker (#831)", () => {
    vi.mocked(invoke).mockResolvedValue([]);
    render(<FileIntakePane projectKey="p" />);
    expect(screen.getByText(/Drop design files or a folder/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /browse a folder/i })).toBeInTheDocument();
  });

  it("lists files already staged in the intake manifest", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      ["intake.json", JSON.stringify([{ name: "hero.png", kind: "image", size: 2048 }])],
    ]);
    render(<FileIntakePane projectKey="p" />);
    expect(await screen.findByText("hero.png")).toBeInTheDocument();
    expect(screen.getByText("image")).toBeInTheDocument(); // kind chip
  });

  it("the Route button queues the route prompt for the planner (#604 slice 2)", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      ["intake.json", JSON.stringify([{ name: "hero.png", kind: "image", size: 1 }])],
    ]);
    render(<FileIntakePane projectKey="proj-x" />);
    fireEvent.click(await screen.findByRole("button", { name: /Route to project/i }));
    expect(useAppStore.getState().pendingPlannerPrompt["proj-x"]).toBe(ROUTE_PROMPT);
    // routing also completes the UI stage by confirming the `ui` section (#837)
    expect(useAppStore.getState().planConfirmedSections["proj-x"]).toContain("ui");
  });
});

describe("planner prompt queue store actions (#604)", () => {
  it("request sets and clear removes per-project", () => {
    useAppStore.setState({ pendingPlannerPrompt: {} });
    useAppStore.getState().requestPlannerPrompt("a", "do X");
    useAppStore.getState().requestPlannerPrompt("b", "do Y");
    expect(useAppStore.getState().pendingPlannerPrompt).toEqual({ a: "do X", b: "do Y" });
    useAppStore.getState().clearPlannerPrompt("a");
    expect(useAppStore.getState().pendingPlannerPrompt).toEqual({ b: "do Y" });
  });
});
