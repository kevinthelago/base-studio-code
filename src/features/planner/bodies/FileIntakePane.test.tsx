import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { FileIntakePane } from "./FileIntakePane";
import { useAppStore } from "@/store";

describe("FileIntakePane (#604)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useAppStore.setState({ pendingPlannerPrompt: {}, planConfirmedSections: {} });
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

  it("the confirm button stages the design (skeleton + ui-stage confirm) — routing moved to triage (#2097)", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined as never); // un-mocked calls (sync_design_to_skeleton) still return a promise
    vi.mocked(invoke).mockResolvedValueOnce([
      ["intake.json", JSON.stringify([{ name: "hero.png", kind: "image", size: 1, hash: "h1" }])],
    ]);
    render(<FileIntakePane projectKey="proj-x" />);
    fireEvent.click(await screen.findByRole("button", { name: /Confirm design staged/i }));
    // Routing is NO LONGER queued here — it happens change-aware on triage (#2097).
    expect(useAppStore.getState().pendingPlannerPrompt["proj-x"]).toBeUndefined();
    // Still confirms the `ui` stage (the user's explicit confirm) …
    expect(useAppStore.getState().planConfirmedSections["proj-x"]).toContain("ui");
    // …and promotes the dropped design into .ui-skeleton/ so the preview shows it (#1373).
    expect(invoke).toHaveBeenCalledWith("sync_design_to_skeleton", { projectKey: "proj-x" });
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
