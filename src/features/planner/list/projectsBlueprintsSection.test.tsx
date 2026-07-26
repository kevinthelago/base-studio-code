import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectsList } from "./ProjectsList";
import { useAppStore } from "@/store";
import { type Blueprint } from "../stages/blueprints";

// The create flow (#3802): `+ New project` opens the full-pane ProjectSetupPage (name + blueprint)
// BETWEEN the list and the planner; the chosen blueprint is bound AT CREATION. These tests drive
// that flow end-to-end through <ProjectsList /> (the setup page's own unit tests live alongside it).

function bp(over: Partial<Blueprint>): Blueprint {
  return { id: "x", name: "X", desc: "", sections: [], ...over };
}

function routeInvoke() {
  vi.mocked(invoke).mockImplementation(((cmd: string) => {
    if (cmd === "list_local_projects") return Promise.resolve([]);
    if (cmd === "github_graphql") return Promise.resolve({ viewer: { projectsV2: { nodes: [] } } });
    return Promise.resolve(null);
  }) as unknown as typeof invoke);
}

/** Click `+ New project` (there can be two — the header + the empty-state — so take the first).
 *  For the same reason every WAIT for the button uses findAllByRole: the singular query throws
 *  on multiple matches, and the empty-state CTA (#3802) made a second one routine. */
function openSetup() {
  fireEvent.click(screen.getAllByRole("button", { name: "+ New project" })[0]);
}

describe("ProjectsList — create flow (setup page)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    routeInvoke();
    useAppStore.setState({
      activeWorkspace: "projects",
      githubToken: "gho_test",
      localDraftProjects: {},
      projectBlueprintId: {},
      blueprints: [],
      // Cleared per-test: the creating tests above set it, and the back-out test asserts nothing
      // was created — without this reset that assertion reads the PREVIOUS test's key.
      planningSessionKey: "",
    });
  });

  it("opens the setup page and lists ALL blueprints — saved AND built-in (#blueprints)", async () => {
    useAppStore.setState({
      blueprints: [
        bp({ id: "mine", name: "My Greenfield", origin: "local" }),
        bp({ id: "stock", name: "Stock Built-in", origin: "built-in" }),
      ],
    });
    render(<ProjectsList />);
    await screen.findAllByRole("button", { name: "+ New project" });
    openSetup();
    expect(await screen.findByText("New project")).toBeTruthy();
    expect(screen.getByText("My Greenfield")).toBeTruthy();
    expect(screen.getByText("Stock Built-in")).toBeTruthy(); // built-ins are surfaced here too
  });

  it("binds the ACTIVE blueprint AT CREATION — not on a later open (#988)", async () => {
    // Regression: opening a project used to adopt the transient global selection. The binding must
    // be captured once, when the project is created, from whatever is selected then.
    useAppStore.setState({
      blueprints: [bp({ id: "fullstack", name: "Full-stack", origin: "local" })],
      activeBlueprintId: "fullstack",
    });
    render(<ProjectsList />);
    await screen.findAllByRole("button", { name: "+ New project" });
    openSetup();
    fireEvent.change(await screen.findByLabelText("Project name"), { target: { value: "My New App" } });
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

  it("binds a NEWLY-SELECTED blueprint (not the active default) at creation", async () => {
    useAppStore.setState({
      blueprints: [
        bp({ id: "default", name: "Default", origin: "built-in" }),
        bp({ id: "api", name: "API Service", origin: "local" }),
      ],
      activeBlueprintId: "default",
    });
    render(<ProjectsList />);
    await screen.findAllByRole("button", { name: "+ New project" });
    openSetup();
    fireEvent.click(await screen.findByText("API Service"));   // select a different blueprint
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Widgets" } });
    fireEvent.click(screen.getByText("start planning →"));
    await waitFor(() => {
      const s = useAppStore.getState();
      expect(s.planningSessionKey).toBe("widgets");
      expect(s.projectBlueprintId[s.planningSessionKey]).toBe("api");
    });
  });

  it("returns to the list (does not create) when the user backs out", async () => {
    useAppStore.setState({
      blueprints: [bp({ id: "mine", name: "My Greenfield", origin: "local" })],
    });
    render(<ProjectsList />);
    await screen.findAllByRole("button", { name: "+ New project" });
    openSetup();
    fireEvent.click(await screen.findByLabelText("Back to projects"));
    // Back on the list; no project was created.
    await screen.findAllByRole("button", { name: "+ New project" });
    expect(useAppStore.getState().planningSessionKey).toBeFalsy();
  });
});
