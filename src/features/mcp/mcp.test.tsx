import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { HooksView } from "./";
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

describe("HooksView", () => {
  beforeEach(() => {
    // Seed both store slices fresh each test; no GitHub token so the projects fetch is a
    // no-op and the screen falls back to "global only" without crashing.
    useAppStore.setState({
      mcpServers: MCP_SEED.map(e => ({ ...e })),
      hooks: HOOK_SEED.map(e => ({ ...e })),
      githubToken: "",
      // Reset the per-page tab memory (#2254): usePageTabs persists the active tab to
      // activePageTab.mcp, which would otherwise leak between tests (a test that clicks to
      // Catalog/Analytics leaves the next test on the wrong tab).
      activePageTab: {},
      pageTabOrder: {},
      detachedSections: {},
    });
  });


  it("the Hooks view shows only hooks", () => {
    render(<HooksView />);
    expect(screen.getByText("Guard lockfiles")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();
    expect(screen.queryByText("Built-in tools")).toBeNull();
  });










  it("the Hooks view has no tabstrip / Analytics tab", () => {
    const { container } = render(<HooksView />);
    const hasAnalytics = Array.from(container.querySelectorAll(".tabstrip .tab"))
      .some((t) => t.textContent?.includes("Analytics"));
    expect(hasAnalytics).toBe(false);
  });

  it("surfaces the always-on bsc-* system hooks as read-only (no toggle)", () => {
    render(<HooksView />);
    // The security floor is listed under its own read-only section.
    expect(screen.getByText("System hooks")).toBeTruthy();
    expect(screen.getByText("bsc-deny")).toBeTruthy();
    expect(screen.getByText("bsc-confine")).toBeTruthy();
    expect(screen.getByText("bsc-scope")).toBeTruthy();
    // Marked "system · always on" and NOT toggleable — its rows carry no enable toggle.
    const systemRow = screen.getByText("bsc-deny").closest(".card-list-row") as HTMLElement;
    expect(within(systemRow).getByText("system · always on")).toBeTruthy();
    expect(systemRow.querySelector(".toggle")).toBeNull();
  });

  it("adds a custom hook from the Hooks view and opens its drawer", () => {
    const { container } = render(<HooksView />);
    fireEvent.click(screen.getByText("+ Custom hook"));
    expect(useAppStore.getState().hooks.some(h => h.id.startsWith("hook_"))).toBe(true);
    expect((container.querySelector(".pane-drawer") as HTMLElement).className).toContain("on");
  });

});
