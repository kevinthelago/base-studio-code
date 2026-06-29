import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectsList } from "./ProjectsList";
import { useAppStore } from "@/store";
import { AUTHORING_BLUEPRINT_ID, type Blueprint } from "../stages/blueprints";

// The Projects-tab redesign adds a dedicated Blueprints section: the user's saved library
// blueprints (built-ins excluded) plus in-progress authoring drafts, kept out of the normal
// Drafts list.

function bp(over: Partial<Blueprint>): Blueprint {
  return { id: "x", name: "X", desc: "", sections: [], category: "greenfield", ...over };
}

function routeInvoke() {
  vi.mocked(invoke).mockImplementation(((cmd: string) => {
    if (cmd === "list_local_projects") return Promise.resolve([]);
    if (cmd === "github_graphql") return Promise.resolve({ viewer: { projectsV2: { nodes: [] } } });
    return Promise.resolve(null);
  }) as unknown as typeof invoke);
}

describe("ProjectsList — Blueprints section", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    routeInvoke();
    useAppStore.setState({
      activeWorkspace: "projects",
      githubToken: "gho_test",
      localDraftProjects: {},
      projectBlueprintId: {},
      planAuthoredBlueprint: {},
      blueprints: [],
    });
  });

  it("shows ALL blueprints — saved AND built-in (#blueprints)", async () => {
    useAppStore.setState({
      blueprints: [
        bp({ id: "mine", name: "My Greenfield", origin: "local", category: "greenfield" }),
        bp({ id: "stock", name: "Stock Built-in", origin: "built-in" }),
      ],
    });
    render(<ProjectsList />);
    await screen.findByText("Blueprints");
    expect(screen.getByText("My Greenfield")).toBeTruthy();
    expect(screen.getByText("Stock Built-in")).toBeTruthy(); // built-ins are surfaced here too now
  });

  it("routes an authoring draft into Blueprints (not Drafts) using its designed blueprint", async () => {
    useAppStore.setState({
      localDraftProjects: {
        normal: { title: "Normal Project", pitch: "p", createdAt: 1 },
        author1: { title: "Author Session", pitch: "", createdAt: 2 },
      },
      projectBlueprintId: { author1: AUTHORING_BLUEPRINT_ID },
      planAuthoredBlueprint: { author1: bp({ id: "draft-bp", name: "Designed Blueprint", category: "transform", sections: [{} as never, {} as never] }) },
    });
    render(<ProjectsList />);
    // Normal draft stays in the Drafts chips; the authoring draft surfaces in the Blueprints rail.
    await screen.findByText("Normal Project");
    expect(screen.getByText("Normal Project")).toBeTruthy();
    expect(screen.getByText("Designed Blueprint")).toBeTruthy();
    expect(screen.queryByText("Author Session")).toBeNull();
  });

  it("binds the SELECTED blueprint AT CREATION — not on a later open (#988)", async () => {
    // Regression: opening a project used to adopt the transient global selection. The binding must
    // be captured once, when the project is created, from whatever is selected then.
    useAppStore.setState({
      blueprints: [bp({ id: "fullstack", name: "Full-stack", origin: "local", category: "greenfield" })],
      activeBlueprintId: "fullstack",
    });
    render(<ProjectsList />);
    await screen.findByText("Blueprints");
    // Target the header button by role — the empty projects column also prints "+ New project".
    fireEvent.click(screen.getByRole("button", { name: "+ New project" }));
    fireEvent.change(screen.getByPlaceholderText("project title…"), { target: { value: "My New App" } });
    fireEvent.click(screen.getByText("start planning →"));
    await waitFor(() => {
      const s = useAppStore.getState();
      // #1741: the workspace key is a minted, opaque stable id — NOT the title-derived "My_New_App".
      expect(s.planningSessionKey).toMatch(/^p-[a-z0-9]+-[a-z0-9]{6}$/);
      expect(s.planningSessionKey).not.toBe("My_New_App");
      // …and the blueprint is bound to the selection at creation, under that same stable key.
      expect(s.projectBlueprintId[s.planningSessionKey]).toBe("fullstack");
    });
  });

  it("clicking a blueprint SELECTS it (sets active) — it does NOT open the planner (#blueprints)", async () => {
    useAppStore.setState({
      blueprints: [bp({ id: "mine", name: "My Greenfield", origin: "local", category: "greenfield" })],
      projectsView: "list",
    });
    render(<ProjectsList />);
    await screen.findByText("Blueprints");
    fireEvent.click(screen.getByText("My Greenfield"));
    const s = useAppStore.getState();
    expect(s.activeBlueprintId).toBe("mine");        // selecting sets it active for the next project
    expect(s.projectsView).toBe("list");             // …without opening the planner
  });

  it("'modify in planner' (card menu) opens the planner authoring session (#blueprints)", async () => {
    useAppStore.setState({
      blueprints: [bp({ id: "mine", name: "My Greenfield", origin: "local", category: "greenfield" })],
    });
    render(<ProjectsList />);
    await screen.findByText("Blueprints");
    fireEvent.click(screen.getByTitle("More options"));     // open the card's menu
    fireEvent.click(screen.getByText("modify in planner"));
    const s = useAppStore.getState();
    expect(s.projectsView).toBe("planning");                              // → planner
    expect(s.projectBlueprintId["My_Greenfield"]).toBe(AUTHORING_BLUEPRINT_ID);
    expect(s.planAuthoredBlueprint["My_Greenfield"]?.name).toBe("My Greenfield"); // seeded with the blueprint
  });
});
