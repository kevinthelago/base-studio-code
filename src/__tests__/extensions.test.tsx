import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ExtensionsScreen } from "../screens/extensions";
import { EXT_CATALOG } from "../data/extensions";
import { useAppStore } from "../store";
import type { ExtensionDef } from "../lib/extensions";

// A small, deterministic store seed: 2 MCP servers (one enabled, one off) and
// one enabled hook → 2 enabled overall.
const SEED: ExtensionDef[] = [
  { id: "e1", kind: "mcp", name: "GitHub", enabled: true, projects: [], transport: "http", url: "https://mcp.github.com/sse", env: [] },
  { id: "e2", kind: "mcp", name: "Filesystem", enabled: false, projects: [], transport: "stdio", command: "npx", args: "@modelcontextprotocol/server-filesystem", env: [] },
  { id: "e3", kind: "hook", name: "Guard lockfiles", enabled: true, projects: [], event: "PreToolUse", matcher: "Write|Edit", hookCommand: "./guard.sh" },
];

const ENABLED = SEED.filter(e => e.enabled).length; // 2

function installedCount(container: HTMLElement): string {
  const installedTab = container.querySelectorAll(".subtabs .t")[0];
  return installedTab.querySelector(".count")!.textContent ?? "";
}

describe("ExtensionsScreen", () => {
  beforeEach(() => {
    // Seed the store fresh each test; no GitHub token so the projects fetch is a
    // no-op and the screen falls back to "global only" without crashing.
    useAppStore.setState({ extensions: SEED.map(e => ({ ...e })), githubToken: "" });
  });

  it("renders the MCP + Hooks groups and the seeded extensions from the store", () => {
    render(<ExtensionsScreen />);
    expect(screen.getByText("MCP servers")).toBeTruthy();
    expect(screen.getByText("Hooks")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Filesystem")).toBeTruthy();
    expect(screen.getByText("Guard lockfiles")).toBeTruthy();
    // First-party group is a static "coming soon" note, not fabricated rows.
    expect(screen.getByText("First-party tools")).toBeTruthy();
  });

  it("shows the enabled count from the store and decrements it on toggle off", () => {
    const { container } = render(<ExtensionsScreen />);
    expect(installedCount(container)).toBe(String(ENABLED));
    const firstOn = container.querySelector(".row-aside .toggle.on") as HTMLElement;
    fireEvent.click(firstOn);
    expect(installedCount(container)).toBe(String(ENABLED - 1));
    // The store itself was flipped, not just local UI state.
    expect(useAppStore.getState().extensions.filter(e => e.enabled).length).toBe(ENABLED - 1);
  });

  it("switches to the catalog tab and renders EXT_CATALOG", () => {
    const { container } = render(<ExtensionsScreen />);
    fireEvent.click(container.querySelectorAll(".subtabs .t")[1]);
    expect(screen.getByText("Browse")).toBeTruthy();
    expect(screen.getByText(EXT_CATALOG[0].name)).toBeTruthy(); // Sentry
  });

  it("filters the catalog by the search input", () => {
    const { container } = render(<ExtensionsScreen />);
    fireEvent.click(container.querySelectorAll(".subtabs .t")[1]);
    const searchBox = container.querySelector(".ext-body input") as HTMLInputElement;
    fireEvent.change(searchBox, { target: { value: "linear" } });
    expect(screen.getByText("Linear")).toBeTruthy();
    expect(screen.queryByText("Sentry")).toBeNull();
  });

  it("adds a catalog item to the store and opens it in the drawer", () => {
    const { container } = render(<ExtensionsScreen />);
    const before = useAppStore.getState().extensions.length;
    fireEvent.click(container.querySelectorAll(".subtabs .t")[1]);
    // Click the first "add" button in the catalog.
    const addBtn = within(screen.getByText("Sentry").closest(".cat-card") as HTMLElement).getByText("add");
    fireEvent.click(addBtn);
    expect(useAppStore.getState().extensions.length).toBe(before + 1);
    expect(useAppStore.getState().extensions.some(e => e.name === "Sentry")).toBe(true);
    // The new extension opens in the drawer for editing.
    const drawer = container.querySelector(".drawer") as HTMLElement;
    expect(drawer.className).toContain("on");
    expect(within(drawer).getByText("Sentry")).toBeTruthy();
  });

  it("opens the config drawer when a row is clicked and closes via the scrim", () => {
    const { container } = render(<ExtensionsScreen />);
    const drawer = container.querySelector(".drawer") as HTMLElement;
    expect(drawer.className).not.toContain("on");
    fireEvent.click(screen.getByText("GitHub"));
    expect(drawer.className).toContain("on");
    expect(within(drawer).getByText("GitHub")).toBeTruthy(); // drawer header name
    fireEvent.click(container.querySelector(".scrim") as HTMLElement);
    expect((container.querySelector(".drawer") as HTMLElement).className).not.toContain("on");
  });

  it("removes the selected extension from the store", () => {
    const { container } = render(<ExtensionsScreen />);
    fireEvent.click(screen.getByText("Filesystem"));
    const drawer = container.querySelector(".drawer") as HTMLElement;
    fireEvent.click(within(drawer).getByText("remove"));
    expect(useAppStore.getState().extensions.some(e => e.id === "e2")).toBe(false);
    expect((container.querySelector(".drawer") as HTMLElement).className).not.toContain("on");
  });
});
