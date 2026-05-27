import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ExtensionsScreen } from "../screens/extensions";
import { EXTENSIONS, EXT_CATALOG } from "../data/extensions";

const ENABLED = EXTENSIONS.filter(e => e.on).length;

function installedCount(container: HTMLElement): string {
  const installedTab = container.querySelectorAll(".subtabs .t")[0];
  return installedTab.querySelector(".count")!.textContent ?? "";
}

describe("ExtensionsScreen", () => {
  it("renders the installed view with the three groups and a known extension", () => {
    render(<ExtensionsScreen />);
    expect(screen.getByText("First-party")).toBeTruthy();
    expect(screen.getByText("MCP servers")).toBeTruthy();
    expect(screen.getByText("Hooks")).toBeTruthy();
    expect(screen.getByText("Context")).toBeTruthy();
  });

  it("shows the enabled count and decrements it when a toggle is switched off", () => {
    const { container } = render(<ExtensionsScreen />);
    expect(installedCount(container)).toBe(String(ENABLED));
    const firstOn = container.querySelector(".row-aside .toggle.on") as HTMLElement;
    fireEvent.click(firstOn);
    expect(installedCount(container)).toBe(String(ENABLED - 1));
  });

  it("switches to the catalog tab", () => {
    const { container } = render(<ExtensionsScreen />);
    fireEvent.click(container.querySelectorAll(".subtabs .t")[1]);
    expect(screen.getByText("Browse")).toBeTruthy();
    expect(screen.getByText(EXT_CATALOG[0].name)).toBeTruthy(); // Sentry
  });

  it("opens the config drawer when a row is clicked", () => {
    const { container } = render(<ExtensionsScreen />);
    const drawer = container.querySelector(".drawer") as HTMLElement;
    expect(drawer.className).not.toContain("on");
    fireEvent.click(screen.getByText("Context"));
    expect(drawer.className).toContain("on");
    expect(within(drawer).getByText("Context")).toBeTruthy(); // drawer header name
    // closing via the scrim
    fireEvent.click(container.querySelector(".scrim") as HTMLElement);
    expect((container.querySelector(".drawer") as HTMLElement).className).not.toContain("on");
  });

  it("reveals the project picker only in project scope", () => {
    const { container } = render(<ExtensionsScreen />);
    expect(container.querySelector(".proj-bar")).toBeNull();
    // scope buttons: [Global, Project, Console]
    fireEvent.click(container.querySelectorAll(".scope button")[1]);
    expect(container.querySelector(".proj-bar")).toBeTruthy();
    expect(screen.getByText("All projects")).toBeTruthy();
  });
});
