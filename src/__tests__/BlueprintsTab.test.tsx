import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Blueprints } from "../screens/projects/BlueprintsTab";
import { useAppStore } from "../store";
import { makeBlueprints } from "../screens/projects/blueprints";

describe("Blueprints tab (#513/#514)", () => {
  beforeEach(() => {
    useAppStore.setState({ blueprints: makeBlueprints(), activeBlueprintId: "default" });
  });

  it("renders the section list, the library, and the active marker", () => {
    render(<Blueprints />);
    expect(screen.getByText("Context")).toBeTruthy();
    expect(screen.getByText("Structure")).toBeTruthy();
    expect(screen.getByText("Full-stack web app")).toBeTruthy(); // library entry
    expect(screen.getByText("★ active")).toBeTruthy();            // default marked active
  });

  it("expanding a section reveals its prompt module + pipelines", () => {
    render(<Blueprints />);
    fireEvent.click(screen.getByText("UI"));
    expect(screen.getByText("Prompt module")).toBeTruthy();
    expect(screen.getByText("Render preview")).toBeTruthy(); // UI seeds this pipeline
  });

  it("toggling the first section persists its enabled flag", () => {
    const { container } = render(<Blueprints />);
    const before = useAppStore.getState().blueprints.find((b) => b.id === "default")!.sections[0].enabled;
    fireEvent.click(container.querySelector(".sw")!); // first switch = first section (Context)
    const after = useAppStore.getState().blueprints.find((b) => b.id === "default")!.sections[0].enabled;
    expect(after).toBe(!before);
  });

  it("set active from the library updates the active blueprint", () => {
    render(<Blueprints />);
    fireEvent.click(screen.getByText("Mobile MVP"));
    fireEvent.click(screen.getAllByText("set as active")[0]);
    expect(useAppStore.getState().activeBlueprintId).toBe("mobile");
  });

  it("Add pipeline opens the picker and adds a pipeline to the section", () => {
    render(<Blueprints />);
    fireEvent.click(screen.getByText("Permissions")); // empty pipelines -> empty state
    fireEvent.click(screen.getAllByText("+ Add pipeline")[0]);
    fireEvent.click(screen.getByText("Scope streams")); // suggested for permissions
    const perms = useAppStore.getState().blueprints.find((b) => b.id === "default")!.sections.find((s) => s.key === "permissions")!;
    expect(perms.pipelines.some((p) => p.id === "scope-streams")).toBe(true);
  });

  it("deletes a blueprint from the library (#598)", () => {
    render(<Blueprints />);
    const before = useAppStore.getState().blueprints.length;
    // Climb from the Mobile MVP label to the card that also holds its delete control.
    let card: HTMLElement | null = screen.getByText("Mobile MVP");
    while (card && !within(card).queryByTitle("Delete blueprint")) card = card.parentElement;
    fireEvent.click(within(card!).getByTitle("Delete blueprint"));
    const after = useAppStore.getState().blueprints;
    expect(after.length).toBe(before - 1);
    expect(after.some((b) => b.id === "mobile")).toBe(false);
  });

  it("imports a blueprint from a pasted share code (#598)", async () => {
    const { blueprintToManifest } = await import("../screens/projects/blueprintShare");
    const { encodeShareCode } = await import("../lib/extensions/manifest");
    const code = encodeShareCode(blueprintToManifest(makeBlueprints().find((b) => b.id === "mobile")!));

    render(<Blueprints />);
    const before = useAppStore.getState().blueprints.length;
    fireEvent.click(screen.getByText("Import")); // header button (modal not open yet)
    fireEvent.change(screen.getByPlaceholderText(/share code/i), { target: { value: code } });
    const importBtns = screen.getAllByRole("button", { name: /^Import$/ });
    fireEvent.click(importBtns[importBtns.length - 1]); // the modal's submit
    const after = useAppStore.getState().blueprints;
    expect(after.length).toBe(before + 1);
    // imported under a fresh id (not "mobile")
    expect(after.filter((b) => b.name === "Mobile MVP").length).toBe(2);
  });

  it("toggles a pipeline as a gate (#532)", () => {
    render(<Blueprints />);
    fireEvent.click(screen.getByText("UI")); // expand UI (has pipelines)
    const ui0 = () => useAppStore.getState().blueprints.find((b) => b.id === "default")!.sections.find((s) => s.key === "ui")!.pipelines[0];
    expect(ui0().gate).toBeFalsy();
    fireEvent.click(screen.getAllByText("⛉ gate")[0]);
    expect(ui0().gate).toBe(true);
  });
});
