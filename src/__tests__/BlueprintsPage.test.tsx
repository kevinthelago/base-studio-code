import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlueprintsPage } from "../screens/planner/BlueprintsPage";
import { useAppStore } from "../store";
import { makeBlueprints, DEFAULT_BLUEPRINT_ID } from "../screens/planner/blueprints";

describe("BlueprintsPage (#609 wiring)", () => {
  beforeEach(() => {
    useAppStore.setState({ blueprints: makeBlueprints(), activeBlueprintId: DEFAULT_BLUEPRINT_ID });
  });

  it("renders the library with the seeded blueprints", () => {
    render(<BlueprintsPage />);
    expect(screen.getByRole("heading", { name: "Blueprints", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Default/, level: 3 })).toBeInTheDocument();
  });

  it("New blueprint → names it and opens the planner seeded with the authoring lifecycle (#923)", () => {
    render(<BlueprintsPage />);
    fireEvent.click(screen.getAllByRole("button", { name: /New blueprint/i })[0]);
    fireEvent.change(screen.getByPlaceholderText(/Internal tool/i), { target: { value: "My Tool" } });
    fireEvent.click(screen.getByRole("button", { name: /Create & open planner/i }));
    const s = useAppStore.getState();
    // binds the draft to the authoring lifecycle PER-PROJECT (not the global active, which would
    // leak into the next normal project), and opens the planner on a draft keyed by the name (#923)
    expect(s.projectBlueprintId["My_Tool"]).toBe("blueprint-author");
    expect(s.activeBlueprintId).toBe(DEFAULT_BLUEPRINT_ID); // global active untouched
    expect(s.planningSessionKey).toBe("My_Tool");
    expect(s.projectsView).toBe("planning");
    expect(s.localDraftProjects["My_Tool"]?.title).toBe("My Tool");
  });

  it("hides the internal authoring lifecycle from the library grid (#923)", () => {
    render(<BlueprintsPage />);
    expect(screen.queryByRole("heading", { name: /Blueprint Author/, level: 3 })).toBeNull();
  });

  it("opens a blueprint into the editor and edits flow to the store", () => {
    render(<BlueprintsPage />);
    fireEvent.click(screen.getByRole("heading", { name: /Default/, level: 3 }).closest(".bp-card")!);
    expect(screen.getByText("Stage flow")).toBeInTheDocument();
    const ta = screen.getByPlaceholderText(/Instructions for the planning agent/i);
    fireEvent.change(ta, { target: { value: "Edited prompt." } });
    const def = useAppStore.getState().blueprints.find((b) => b.id === DEFAULT_BLUEPRINT_ID)!;
    expect(def.sections[0].prompt).toBe("Edited prompt.");
  });

  it("navigates to the import-from-gist screen and back (#923)", () => {
    render(<BlueprintsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Import from gist/i }));
    expect(screen.getByRole("heading", { name: /Import from gist/, level: 1 })).toBeInTheDocument();
    // the gist source is shown (no mock catalog); navigate back
    expect(screen.getByText(/gist source ·/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Blueprints$/i }));
    expect(screen.getByRole("heading", { name: "Blueprints", level: 1 })).toBeInTheDocument();
  });
});
