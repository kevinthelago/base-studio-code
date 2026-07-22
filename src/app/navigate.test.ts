// #3602 — the unified navigate helper. Two layers of coverage:
//  1. `applyNavigation`/`dispatchPage` over a FAKE store — proves each workspace's page/entity routes to
//     the RIGHT setter, and that page+entity are set BEFORE the workspace switch (so the target screen
//     mounts already on the right page, never flashing its last-viewed one).
//  2. The real store `navigate` action — proves the wiring, so a caller genuinely cannot forget the page.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyNavigation, dispatchPage } from "./navigate";
import type { AppStore } from "@/store/types";
import { useAppStore } from "@/store";

/** A store stub exposing only the setters navigate touches, each a spy. */
function fakeStore() {
  return {
    setWorkspace: vi.fn(),
    setActivePageTab: vi.fn(),
    setProjectsPageMode: vi.fn(),
    setGithubTab: vi.fn(),
    setAutomationsTab: vi.fn(),
    setSettingsSection: vi.fn(),
    setGlanceDrill: vi.fn(),
  };
}

describe("applyNavigation — per-workspace page dispatch (#3602)", () => {
  it("routes tabbed workspaces (glance/skills/mcp/security) through setActivePageTab keyed by workspace", () => {
    for (const ws of ["glance", "skills", "mcp", "security"] as const) {
      const s = fakeStore();
      applyNavigation(s as unknown as AppStore, { workspace: ws, page: "x" });
      expect(s.setActivePageTab).toHaveBeenCalledWith(ws, "x");
      expect(s.setWorkspace).toHaveBeenCalledWith(ws);
    }
  });

  it("routes projects → setProjectsPageMode", () => {
    const s = fakeStore();
    applyNavigation(s as unknown as AppStore, { workspace: "projects", page: "designs" });
    expect(s.setProjectsPageMode).toHaveBeenCalledWith("designs");
    expect(s.setActivePageTab).not.toHaveBeenCalled();
  });

  it("routes github → setGithubTab, automation → setAutomationsTab, settings → setSettingsSection", () => {
    const gh = fakeStore();
    applyNavigation(gh as unknown as AppStore, { workspace: "github", page: "issues" });
    expect(gh.setGithubTab).toHaveBeenCalledWith("issues");

    const au = fakeStore();
    applyNavigation(au as unknown as AppStore, { workspace: "automation", page: "history" });
    expect(au.setAutomationsTab).toHaveBeenCalledWith("history");

    const se = fakeStore();
    applyNavigation(se as unknown as AppStore, { workspace: "settings", page: "github" });
    expect(se.setSettingsSection).toHaveBeenCalledWith("github");
  });

  it("console carries no string page: a page-less navigate only switches the workspace", () => {
    const s = fakeStore();
    applyNavigation(s as unknown as AppStore, { workspace: "console" });
    expect(s.setWorkspace).toHaveBeenCalledWith("console");
    expect(s.setActivePageTab).not.toHaveBeenCalled();
    expect(s.setProjectsPageMode).not.toHaveBeenCalled();
  });

  it("dispatchPage is a no-op for a workspace with no page mechanism (console)", () => {
    const s = fakeStore();
    dispatchPage(s as unknown as AppStore, "console", "anything");
    expect(s.setActivePageTab).not.toHaveBeenCalled();
    expect(s.setProjectsPageMode).not.toHaveBeenCalled();
  });

  it("omitting page leaves the page untouched; omitting drill leaves the drill untouched", () => {
    const s = fakeStore();
    applyNavigation(s as unknown as AppStore, { workspace: "glance" });
    expect(s.setActivePageTab).not.toHaveBeenCalled();
    expect(s.setGlanceDrill).not.toHaveBeenCalled();
    expect(s.setWorkspace).toHaveBeenCalledWith("glance");
  });

  it("drill routes to the entity setter — including an explicit null to CLEAR it", () => {
    const set = fakeStore();
    applyNavigation(set as unknown as AppStore, { workspace: "glance", page: "network", drill: "proj-a" });
    expect(set.setGlanceDrill).toHaveBeenCalledWith("proj-a");

    const clear = fakeStore();
    applyNavigation(clear as unknown as AppStore, { workspace: "glance", drill: null });
    expect(clear.setGlanceDrill).toHaveBeenCalledWith(null);
  });

  it("sets the entity + page BEFORE switching the workspace (mounts on the right page, no flash)", () => {
    const s = fakeStore();
    applyNavigation(s as unknown as AppStore, { workspace: "glance", page: "network", drill: "proj" });
    const drillOrder = s.setGlanceDrill.mock.invocationCallOrder[0];
    const pageOrder = s.setActivePageTab.mock.invocationCallOrder[0];
    const wsOrder = s.setWorkspace.mock.invocationCallOrder[0];
    expect(drillOrder).toBeLessThan(wsOrder);
    expect(pageOrder).toBeLessThan(wsOrder);
  });
});

describe("store navigate action — the wiring cannot forget the page (#3602)", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeWorkspace: "console",
      glanceDrill: null,
      activePageTab: {},
      projectsPageMode: "projects",
      settingsSection: "appearance",
    });
  });

  it("navigate sets workspace + page + drill atomically", () => {
    useAppStore.getState().navigate({ workspace: "glance", page: "network", drill: "proj-x" });
    const s = useAppStore.getState();
    expect(s.activeWorkspace).toBe("glance");
    expect(s.activePageTab.glance).toBe("network");
    expect(s.glanceDrill).toBe("proj-x");
  });

  it("navigate to settings lands on the named section, not the last-viewed one", () => {
    useAppStore.getState().navigate({ workspace: "settings", page: "github" });
    const s = useAppStore.getState();
    expect(s.activeWorkspace).toBe("settings");
    expect(s.settingsSection).toBe("github");
  });

  it("navigate to a projects page sets the page mode", () => {
    useAppStore.getState().navigate({ workspace: "projects", page: "designs" });
    const s = useAppStore.getState();
    expect(s.activeWorkspace).toBe("projects");
    expect(s.projectsPageMode).toBe("designs");
  });
});
