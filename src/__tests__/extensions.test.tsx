import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
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

const ENABLED = SEED.filter(e => e.enabled).length;              // 2 overall
const MCP_ENABLED = SEED.filter(e => e.kind === "mcp" && e.enabled).length; // 1 on the MCP page

function installedCount(container: HTMLElement): string {
  const installedTab = container.querySelectorAll(".tabstrip .tab")[0];
  return installedTab.querySelector(".count")!.textContent ?? "";
}

describe("ExtensionsScreen", () => {
  beforeEach(() => {
    // Seed the store fresh each test; no GitHub token so the projects fetch is a
    // no-op and the screen falls back to "global only" without crashing.
    useAppStore.setState({ extensions: SEED.map(e => ({ ...e })), githubToken: "" });
  });

  it("MCP page shows only MCP servers (hooks moved to Automations, #865)", () => {
    render(<ExtensionsScreen kind="mcp" />);
    expect(screen.getByText("MCP servers")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Filesystem")).toBeTruthy();
    // First-party group is a static "coming soon" note, not fabricated rows.
    expect(screen.getByText("First-party tools")).toBeTruthy();
    // The hook is NOT on the MCP page.
    expect(screen.queryByText("Guard lockfiles")).toBeNull();
  });

  it("the embedded Hooks view shows only hooks", () => {
    render(<ExtensionsScreen kind="hook" embedded />);
    expect(screen.getByText("Guard lockfiles")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();
    expect(screen.queryByText("First-party tools")).toBeNull();
  });

  it("shows the MCP enabled count from the store and decrements it on toggle off", () => {
    const { container } = render(<ExtensionsScreen kind="mcp" />);
    expect(installedCount(container)).toBe(String(MCP_ENABLED)); // 1
    const firstOn = container.querySelector(".row-aside .toggle.on") as HTMLElement;
    fireEvent.click(firstOn);
    expect(installedCount(container)).toBe(String(MCP_ENABLED - 1)); // 0
    // The store itself was flipped (the hook stays enabled, so 1 overall remains).
    expect(useAppStore.getState().extensions.filter(e => e.enabled).length).toBe(ENABLED - 1);
  });

  it("switches to the catalog tab and renders EXT_CATALOG", () => {
    const { container } = render(<ExtensionsScreen />);
    fireEvent.click(container.querySelectorAll(".tabstrip .tab")[1]);
    expect(screen.getByText("Browse")).toBeTruthy();
    expect(screen.getByText(EXT_CATALOG[0].name)).toBeTruthy(); // Compliance (first-party)
  });

  it("filters the catalog by the search input", () => {
    const { container } = render(<ExtensionsScreen />);
    fireEvent.click(container.querySelectorAll(".tabstrip .tab")[1]);
    const searchBox = container.querySelector(".ext-body input") as HTMLInputElement;
    fireEvent.change(searchBox, { target: { value: "complexity" } });
    expect(screen.getByText("Complexity Analyzer")).toBeTruthy();
    expect(screen.queryByText("Dependency Graph")).toBeNull();
  });

  it("downloads a catalog server: one 'download' action (no 'add'), clones + adds to Installed silently (#885)", async () => {
    const { container } = render(<ExtensionsScreen kind="mcp" />);
    fireEvent.click(container.querySelectorAll(".tabstrip .tab")[1]); // catalog
    const card = screen.getByText("Compliance").closest(".cat-card") as HTMLElement;
    // A downloadable first-party server shows only "download" — the "add" button is gone.
    expect(within(card).queryByText("add")).toBeNull();
    fireEvent.click(within(card).getByText("download"));
    // Clone (mock resolves) → added to Installed; build runs after. No drawer opens.
    await waitFor(() => expect(useAppStore.getState().extensions.some(e => e.name === "Compliance")).toBe(true));
    expect((container.querySelector(".drawer") as HTMLElement).className).not.toContain("on");
  });

  it("hides catalog entries that are already installed (#885)", () => {
    useAppStore.setState({
      extensions: [{ id: "c", kind: "mcp", name: "Compliance", enabled: true, projects: [], transport: "stdio", command: "uv", args: "x", env: [] }],
      githubToken: "",
    });
    const { container } = render(<ExtensionsScreen kind="mcp" />);
    fireEvent.click(container.querySelectorAll(".tabstrip .tab")[1]); // catalog
    expect(screen.queryByText("Compliance")).toBeNull();          // installed → not in the catalog
    expect(screen.getByText("Complexity Analyzer")).toBeTruthy(); // not installed → still listed
  });

  it("shows a version/update control on an installed downloadable server (#885)", async () => {
    useAppStore.setState({
      extensions: [{ id: "c", kind: "mcp", name: "Compliance", enabled: true, projects: [], transport: "stdio", command: "uv", args: "x", env: [] }],
      githubToken: "",
    });
    render(<ExtensionsScreen kind="mcp" />); // opens on the Installed tab
    // The control runs the version check on open; with the invoke mock it stays in "checking…".
    expect(await screen.findByText("checking…")).toBeTruthy();
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

  it("MCP page has an Analytics tab that renders the telemetry surface (zero state)", async () => {
    const { container } = render(<ExtensionsScreen kind="mcp" />);
    const analyticsTab = Array.from(container.querySelectorAll(".tabstrip .tab"))
      .find((t) => t.textContent?.includes("Analytics")) as HTMLElement;
    expect(analyticsTab).toBeTruthy();
    fireEvent.click(analyticsTab);
    // KPI cards + the call-results zero state render (read_mcp_log mock resolves null → empty).
    expect(await screen.findByText("Total calls")).toBeTruthy();
    expect(screen.getByText("Calls over time")).toBeTruthy();
    expect(screen.getByText(/No calls recorded yet/)).toBeTruthy();
  });

  it("the embedded Hooks view has no Analytics tab", () => {
    const { container } = render(<ExtensionsScreen kind="hook" embedded />);
    const hasAnalytics = Array.from(container.querySelectorAll(".tabstrip .tab"))
      .some((t) => t.textContent?.includes("Analytics"));
    expect(hasAnalytics).toBe(false);
  });

  it("opens the first tab; empty installed shows a CTA to the catalog", () => {
    useAppStore.setState({ extensions: [], pageTabOrder: {}, detachedSections: {} });
    const { container } = render(<ExtensionsScreen />);
    // New model (#463): the page opens its front tab (installed) — empty installed
    // renders a clear CTA into the catalog.
    expect(container.querySelectorAll(".tabstrip .tab")[0].className).toContain("active");
    expect(screen.getByText("No MCP servers installed")).toBeTruthy();
    // The CTA switches to the catalog tab.
    fireEvent.click(screen.getByText("Browse the catalog →"));
    expect(container.querySelectorAll(".tabstrip .tab")[1].className).toContain("active");
    expect(screen.getByText(EXT_CATALOG[0].name)).toBeTruthy();
  });
});
