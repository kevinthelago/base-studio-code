import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Blueprints } from "../screens/projects/BlueprintsTab";
import { useAppStore } from "../store";
import { starterBlueprints } from "../screens/projects/blueprints";

describe("Blueprints tab (#513)", () => {
  beforeEach(() => {
    useAppStore.setState({ blueprints: starterBlueprints(), activeBlueprintId: "web-app" });
  });

  it("lists the starter blueprints and shows the active editor", () => {
    render(<Blueprints />);
    expect(screen.getByText("Web app")).toBeTruthy();
    expect(screen.getByText("CLI tool")).toBeTruthy();
    // active badge present
    expect(screen.getByText("● active")).toBeTruthy();
    // stage rows rendered (Context among them)
    expect(screen.getByText("Context")).toBeTruthy();
  });

  it("toggling a stage checkbox updates that blueprint's config", () => {
    render(<Blueprints />);
    const cb = screen.getByLabelText("Automations enabled") as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb);
    expect(useAppStore.getState().blueprints.find((b) => b.id === "web-app")!.config.enabled.automations).toBe(false);
  });

  it("selecting another blueprint and setting it active updates the store", () => {
    render(<Blueprints />);
    fireEvent.click(screen.getByText("CLI tool"));
    fireEvent.click(screen.getByText("Set active"));
    expect(useAppStore.getState().activeBlueprintId).toBe("cli-tool");
  });
});
