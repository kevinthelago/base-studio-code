import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectsList } from "./ProjectsList";
import { useAppStore } from "@/store";
import { type Blueprint } from "../stages/blueprints";

// The Projects-tab Blueprints section: the user's saved library blueprints plus the built-in
// app templates, selectable for the next project.

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
      // #2409 (supersedes the #1741 minted id): the workspace key IS the name-derived slug,
      // frozen at creation — `projectSlug("My New App")`.
      expect(s.planningSessionKey).toBe("my-new-app");
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
});
