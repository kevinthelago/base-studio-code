import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GistPreview } from "./GistPreview";
import { type PreviewBlueprint } from "./BlueprintModals";
import { type Blueprint, type BlueprintStage } from "../stages/blueprints";

const SECTIONS = [
  { uid: "u1", key: "discovery", name: "Discovery", glyph: "◆", icon: "flag", hue: 70, gate: "", deps: [], blurb: "", prompt: "Establish the goal, users, and scope.", enabled: true, expanded: false },
  { uid: "u2", key: "deployment", name: "Deployment", glyph: "▦", icon: "account_tree", hue: 230, gate: "", deps: [], blurb: "", prompt: "Link the repositories and define how each ships.", enabled: true, expanded: false },
] as BlueprintStage[];
const PREVIEW: PreviewBlueprint = {
  name: "Fresh BP", icon: "F", h: 70, sections: SECTIONS,
  blueprint: { id: "fresh", name: "Fresh BP", desc: "", category: "greenfield", sections: SECTIONS } as Blueprint,
};

describe("GistPreview", () => {
  it("shows a loading affordance while the preview is resolving", () => {
    render(<GistPreview entry={{ loading: true }} />);
    expect(screen.getByText(/reading the blueprint/i)).toBeTruthy();
  });

  it("surfaces a resolve error", () => {
    render(<GistPreview entry={{ error: "no extension.json manifest" }} />);
    expect(screen.getByText(/couldn't read this blueprint/i)).toBeTruthy();
    expect(screen.getByText(/no extension\.json manifest/)).toBeTruthy();
  });

  it("renders the blueprint's stages + toggles the raw JSON", () => {
    render(<GistPreview entry={{ data: PREVIEW }} />);
    // structured stage view
    expect(screen.getByText("Discovery")).toBeTruthy();
    expect(screen.getByText("Deployment")).toBeTruthy();
    expect(screen.getByText("Establish the goal, users, and scope.")).toBeTruthy();
    // raw JSON is hidden until toggled
    expect(screen.getByText(/view raw JSON/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/view raw JSON/i));
    expect(screen.getByText(/hide raw JSON/i)).toBeTruthy();
  });
});
