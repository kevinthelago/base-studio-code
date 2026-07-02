import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { FileIntakePane } from "./FileIntakePane";
import { useAppStore } from "@/store";

describe("FileIntakePane (#604)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useAppStore.setState({ pendingPlannerPrompt: {}, planConfirmedStages: {} });
  });

  it("renders the drop zone with click-to-browse-a-folder (#831)", () => {
    vi.mocked(invoke).mockResolvedValue([]);
    render(<FileIntakePane projectKey="p" />);
    expect(screen.getByText(/Drop design files or a folder/i)).toBeInTheDocument();
    expect(screen.getByText(/click to browse a folder/i)).toBeInTheDocument();
  });

  it("lists files already staged in the intake manifest", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      ["intake.json", JSON.stringify([{ name: "hero.png", kind: "image", size: 2048 }])],
    ]);
    render(<FileIntakePane projectKey="p" />);
    expect(await screen.findByText("hero.png")).toBeInTheDocument();
    expect(screen.getByText("image")).toBeInTheDocument(); // kind chip
  });

  // #2121 — the pane no longer has ANY route/confirm control inside it. Syncing the skeleton,
  // stamping routed hashes, and confirming the `ui` stage are driven entirely by the UI stage's
  // footer action (Planning.tsx `routeDesignToProject`); the per-repo routing happens change-aware
  // on triage (#2097). This surface is intake-only, so there's no in-pane action to assert here.
  it("has no route/confirm button inside the pane (#2121) — the surface is intake-only", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      ["intake.json", JSON.stringify([{ name: "hero.png", kind: "image", size: 1, hash: "h1" }])],
    ]);
    render(<FileIntakePane projectKey="proj-x" />);
    expect(await screen.findByText("hero.png")).toBeInTheDocument(); // staged list renders
    expect(screen.queryByRole("button", { name: /Confirm design staged/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /route design/i })).toBeNull();
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
