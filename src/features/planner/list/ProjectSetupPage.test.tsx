import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectSetupPage } from "./ProjectSetupPage";
import { useAppStore } from "@/store";

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

  it("renders the setup page: name input, blueprint list, and a gated start", () => {
    render(<ProjectSetupPage onBack={() => {}} onStart={() => {}} />);
    expect(screen.getByText("New project")).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByText("API Service")).toBeInTheDocument();
    // Start is disabled until the project is named.
    expect(screen.getByText("start planning →").closest("button")).toBeDisabled();
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
