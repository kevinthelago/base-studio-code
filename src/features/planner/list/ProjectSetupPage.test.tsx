import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectSetupPage } from "./ProjectSetupPage";
import { useAppStore } from "@/store";

// The page now hosts the persistent CloudBlueprints column (#3802) — mock the gist client so its
// load is deterministic (no network / invoke) and never floods these unit tests.
vi.mock("@/features/planner/lib/gist/gist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/planner/lib/gist/gist")>()),
  listBlueprintGists: vi.fn(async () => []),
}));

describe("ProjectSetupPage", () => {
  beforeEach(() => {
    useAppStore.setState({
      blueprints: [
        { id: "default", name: "Default", desc: "", sections: [], category: "greenfield" },
        { id: "api", name: "API Service", desc: "", sections: [], category: "greenfield" },
      ] as never,
      activeBlueprintId: "default",
    });
  });

  it("renders the setup page: name input, blueprint list, cloud column, and a gated start", () => {
    render(<ProjectSetupPage onBack={() => {}} onStart={() => {}} />);
    expect(screen.getByText("New project")).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByText("API Service")).toBeInTheDocument();
    // The persistent cloud column replaces the old import modal — no import button, a source input.
    expect(screen.queryByText("import")).not.toBeInTheDocument();
    expect(screen.getByText("Cloud blueprints")).toBeInTheDocument();
    expect(screen.getByLabelText("Cloud blueprints source (GitHub account)")).toBeInTheDocument();
    // Start is disabled until the project is named.
    expect(screen.getByText("start planning →").closest("button")).toBeDisabled();
  });

  it("frames the name field as step 1, the page's primary action (#3840)", () => {
    const { container } = render(<ProjectSetupPage onBack={() => {}} onStart={() => {}} />);
    // The two steps read as a sequence, so the field is not just another row in the column.
    expect(screen.getByText("step 1")).toBeInTheDocument();
    expect(screen.getByText("Name the project")).toBeInTheDocument();
    expect(screen.getByText("step 2")).toBeInTheDocument();
    expect(screen.getByText("Pick a blueprint")).toBeInTheDocument();
    // …and the input itself is enlarged, not default-sized.
    const input = screen.getByLabelText("Project name") as HTMLInputElement;
    expect(input.style.fontSize).toBe("15px");
    expect(container.querySelector(".setup-name")).toBeTruthy();
  });

  it("defaults the blueprint to the active one and starts with the typed name", () => {
    const onStart = vi.fn();
    render(<ProjectSetupPage onBack={() => {}} onStart={onStart} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "My App" } });
    expect(screen.getByText("start planning →").closest("button")).not.toBeDisabled();
    fireEvent.click(screen.getByText("start planning →"));
    expect(onStart).toHaveBeenCalledWith("My App", "default");
  });

  it("starts with a newly-selected blueprint", () => {
    const onStart = vi.fn();
    render(<ProjectSetupPage onBack={() => {}} onStart={onStart} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "My App" } });
    fireEvent.click(screen.getByText("API Service"));      // select it (BlueprintCard onUse)
    fireEvent.click(screen.getByText("start planning →"));
    expect(onStart).toHaveBeenCalledWith("My App", "api");
  });

  it("starts on Enter in the name field once named", () => {
    const onStart = vi.fn();
    render(<ProjectSetupPage onBack={() => {}} onStart={onStart} />);
    const name = screen.getByLabelText("Project name");
    fireEvent.change(name, { target: { value: "My App" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onStart).toHaveBeenCalledWith("My App", "default");
  });

  it("does not start with a blank name", () => {
    const onStart = vi.fn();
    render(<ProjectSetupPage onBack={() => {}} onStart={onStart} />);
    fireEvent.click(screen.getByText("start planning →"));  // still disabled
    expect(onStart).not.toHaveBeenCalled();
  });

  it("goes back via the header back button", () => {
    const onBack = vi.fn();
    render(<ProjectSetupPage onBack={onBack} onStart={() => {}} />);
    fireEvent.click(screen.getByLabelText("Back to projects"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
