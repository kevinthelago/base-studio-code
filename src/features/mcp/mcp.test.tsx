import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { McpScreen, HooksView } from "./";
import { MCP_CATALOG } from "@/shared/data/mcpCatalog";
import { useAppStore } from "@/store";
import type { McpServer } from "./lib/mcpServers";
import type { Hook } from "./lib/hooks";

// Two MCP servers (one enabled, one off) → 1 enabled on the MCP page.
const MCP_SEED: McpServer[] = [
  { id: "e1", name: "GitHub", enabled: true, projects: [], transport: "http", url: "https://mcp.github.com/sse", env: [] },
  { id: "e2", name: "Filesystem", enabled: false, projects: [], transport: "stdio", command: "npx", args: "@modelcontextprotocol/server-filesystem", env: [] },
];
// One enabled hook (lives in the Automations Hooks view, not the MCP page).
const HOOK_SEED: Hook[] = [
  { id: "e3", name: "Guard lockfiles", enabled: true, projects: [], event: "PreToolUse", matcher: "Write|Edit", command: "./guard.sh" },
];

const MCP_ENABLED = MCP_SEED.filter(e => e.enabled).length; // 1

// The first browsable catalog entry — built-in servers (Research #1196, Compliance #1005) live in
// the "Built-in tools" section, not the downloadable browse list, so they're filtered out here.
const FIRST_BROWSABLE = MCP_CATALOG.find(c => !c.builtIn)!.name;

function installedCount(container: HTMLElement): string {
  const installedTab = container.querySelectorAll(".tabstrip .tab")[0];
  return installedTab.querySelector(".count")!.textContent ?? "";
}

describe("McpScreen + HooksView", () => {
  beforeEach(() => {
    // Seed both store slices fresh each test; no GitHub token so the projects fetch is a
    // no-op and the screen falls back to "global only" without crashing.
    useAppStore.setState({
      mcpServers: MCP_SEED.map(e => ({ ...e })),
      hooks: HOOK_SEED.map(e => ({ ...e })),
      githubToken: "",
    });
  });

  it("MCP page shows only MCP servers (hooks live in Automations)", () => {
    render(<McpScreen />);
    expect(screen.getByText("MCP servers")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Filesystem")).toBeTruthy();
    // Built-in tools section (#1196 / #1005) lists the always-available native servers.
    expect(screen.getByText("Built-in tools")).toBeTruthy();
    expect(screen.getByText("Research")).toBeTruthy();
    expect(screen.getByText("Compliance")).toBeTruthy();
    // The hook is NOT on the MCP page.
    expect(screen.queryByText("Guard lockfiles")).toBeNull();
  });

  it("the Hooks view shows only hooks", () => {
    render(<HooksView />);
    expect(screen.getByText("Guard lockfiles")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();
    expect(screen.queryByText("Built-in tools")).toBeNull();
  });

  it("shows the MCP enabled count from the store and decrements it on toggle off", () => {
    const { container } = render(<McpScreen />);
    expect(installedCount(container)).toBe(String(MCP_ENABLED)); // 1
    const firstOn = container.querySelector(".row-aside .toggle.on") as HTMLElement;
    fireEvent.click(firstOn);
    expect(installedCount(container)).toBe(String(MCP_ENABLED - 1)); // 0
    // The store's mcpServers slice was flipped; the hook (a separate slice) is untouched.
    expect(useAppStore.getState().mcpServers.filter(e => e.enabled).length).toBe(0);
    expect(useAppStore.getState().hooks.filter(e => e.enabled).length).toBe(1);
  });

  it("switches to the catalog tab and renders MCP_CATALOG", () => {
    const { container } = render(<McpScreen />);
    fireEvent.click(container.querySelectorAll(".tabstrip .tab")[1]);
    expect(screen.getByText("Browse")).toBeTruthy();
    expect(screen.getByText(FIRST_BROWSABLE)).toBeTruthy(); // first downloadable first-party server
  });

  it("filters the catalog by the search input", () => {
    const { container } = render(<McpScreen />);
    fireEvent.click(container.querySelectorAll(".tabstrip .tab")[1]);
    const searchBox = container.querySelector(".ext-body input") as HTMLInputElement;
    fireEvent.change(searchBox, { target: { value: "complexity" } });
    expect(screen.getByText("Complexity Analyzer")).toBeTruthy();
    expect(screen.queryByText("Dependency Graph")).toBeNull();
  });

  it("downloads a catalog server: one 'download' action (no 'add'), clones + adds to Installed silently (#885)", async () => {
    const { container } = render(<McpScreen />);
    fireEvent.click(container.querySelectorAll(".tabstrip .tab")[1]); // catalog
    const card = screen.getByText("Dependency Graph").closest(".cat-card") as HTMLElement;
    // A downloadable first-party server shows only "download" — the "add" button is gone.
    expect(within(card).queryByText("add")).toBeNull();
    fireEvent.click(within(card).getByText("download"));
    // Clone (mock resolves) → added to Installed; build runs after. No drawer opens.
    await waitFor(() => expect(useAppStore.getState().mcpServers.some(e => e.name === "Dependency Graph")).toBe(true));
    expect((container.querySelector(".drawer") as HTMLElement).className).not.toContain("on");
  });

  it("hides catalog entries that are already installed (#885)", () => {
    useAppStore.setState({
      mcpServers: [{ id: "c", name: "Dependency Graph", enabled: true, projects: [], transport: "stdio", command: "node", args: "x", env: [] }],
      githubToken: "",
    });
    const { container } = render(<McpScreen />);
    fireEvent.click(container.querySelectorAll(".tabstrip .tab")[1]); // catalog
    expect(screen.queryByText("Dependency Graph")).toBeNull();    // installed → not in the catalog
    expect(screen.getByText("Complexity Analyzer")).toBeTruthy(); // not installed → still listed
  });

  it("shows a version/update control on an installed downloadable server (#885)", async () => {
    useAppStore.setState({
      mcpServers: [{ id: "c", name: "Dependency Graph", enabled: true, projects: [], transport: "stdio", command: "node", args: "x", env: [] }],
      githubToken: "",
    });
    render(<McpScreen />); // opens on the Installed tab
    // The control runs the version check on open; with the invoke mock it stays in "checking…".
    expect(await screen.findByText("checking…")).toBeTruthy();
  });

  it("opens the config drawer when a row is clicked and closes via the scrim", () => {
    const { container } = render(<McpScreen />);
    const drawer = container.querySelector(".drawer") as HTMLElement;
    expect(drawer.className).not.toContain("on");
    fireEvent.click(screen.getByText("GitHub"));
    expect(drawer.className).toContain("on");
    expect(within(drawer).getByText("GitHub")).toBeTruthy(); // drawer header name
    fireEvent.click(container.querySelector(".scrim") as HTMLElement);
    expect((container.querySelector(".drawer") as HTMLElement).className).not.toContain("on");
  });

  it("removes the selected server from the store", () => {
    const { container } = render(<McpScreen />);
    fireEvent.click(screen.getByText("Filesystem"));
    const drawer = container.querySelector(".drawer") as HTMLElement;
    fireEvent.click(within(drawer).getByText("remove"));
    expect(useAppStore.getState().mcpServers.some(e => e.id === "e2")).toBe(false);
    expect((container.querySelector(".drawer") as HTMLElement).className).not.toContain("on");
  });

  it("MCP page has an Analytics tab that renders the telemetry surface (zero state)", async () => {
    const { container } = render(<McpScreen />);
    const analyticsTab = Array.from(container.querySelectorAll(".tabstrip .tab"))
      .find((t) => t.textContent?.includes("Analytics")) as HTMLElement;
    expect(analyticsTab).toBeTruthy();
    fireEvent.click(analyticsTab);
    // KPI cards + the call-results zero state render (read_mcp_log mock resolves null → empty).
    expect(await screen.findByText("Total calls")).toBeTruthy();
    expect(screen.getByText("Calls over time")).toBeTruthy();
    expect(screen.getByText(/No calls recorded yet/)).toBeTruthy();
  });

  it("the Hooks view has no tabstrip / Analytics tab", () => {
    const { container } = render(<HooksView />);
    const hasAnalytics = Array.from(container.querySelectorAll(".tabstrip .tab"))
      .some((t) => t.textContent?.includes("Analytics"));
    expect(hasAnalytics).toBe(false);
  });

  it("adds a custom hook from the Hooks view and opens its drawer", () => {
    const { container } = render(<HooksView />);
    fireEvent.click(screen.getByText("+ Custom hook"));
    expect(useAppStore.getState().hooks.some(h => h.id.startsWith("hook_"))).toBe(true);
    expect((container.querySelector(".drawer") as HTMLElement).className).toContain("on");
  });

  it("opens the first tab; empty installed shows a CTA to the catalog", () => {
    useAppStore.setState({ mcpServers: [], pageTabOrder: {}, detachedSections: {} });
    const { container } = render(<McpScreen />);
    // The page opens its front tab (installed) — empty installed renders a clear CTA.
    expect(container.querySelectorAll(".tabstrip .tab")[0].className).toContain("active");
    expect(screen.getByText("No MCP servers installed")).toBeTruthy();
    // The CTA switches to the catalog tab.
    fireEvent.click(screen.getByText("Browse the catalog →"));
    expect(container.querySelectorAll(".tabstrip .tab")[1].className).toContain("active");
    expect(screen.getByText(FIRST_BROWSABLE)).toBeTruthy();
  });
});
