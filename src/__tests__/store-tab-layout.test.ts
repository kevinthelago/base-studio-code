import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../store";

const BASE_TABS = [
  { name: "workspace", layout: "3×3", state: "run" as const },
];

beforeEach(() => {
  useAppStore.setState({
    tabs: BASE_TABS.map((t) => ({ ...t })),
    activeTabIdx: 0,
    paneNames: {},
    paneCwds: {},
    paneGitInfo: {},
  });
});

// ── renameTab ─────────────────────────────────────────────────────────────────

describe("renameTab", () => {
  it("updates the tab name", () => {
    useAppStore.getState().renameTab(0, "my-workspace");
    expect(useAppStore.getState().tabs[0].name).toBe("my-workspace");
  });

  it("does not affect other tabs", () => {
    useAppStore.getState().addTab({ name: "other", layout: "1×1", state: "idle" });
    useAppStore.getState().renameTab(0, "renamed");
    expect(useAppStore.getState().tabs[1].name).toBe("other");
  });

  it("preserves tab layout and state when renaming", () => {
    useAppStore.getState().renameTab(0, "new-name");
    const tab = useAppStore.getState().tabs[0];
    expect(tab.layout).toBe("3×3");
    expect(tab.state).toBe("run");
  });
});

// ── setTabLayout ──────────────────────────────────────────────────────────────

describe("setTabLayout", () => {
  it("updates the tab layout string", () => {
    useAppStore.getState().setTabLayout(0, "2×2");
    expect(useAppStore.getState().tabs[0].layout).toBe("2×2");
  });

  it("preserves tab name when changing layout", () => {
    useAppStore.getState().setTabLayout(0, "1×1");
    expect(useAppStore.getState().tabs[0].name).toBe("workspace");
  });

  it("trims pane names for removed panes when shrinking", () => {
    // 3×3 = 9 panes; name panes 0-8
    for (let i = 0; i < 9; i++) {
      useAppStore.getState().setPaneName(0, i, `agent-${i}`);
    }
    // Shrink to 2×2 = 4 panes
    useAppStore.getState().setTabLayout(0, "2×2");
    const names = useAppStore.getState().paneNames[0];
    // Panes 0–3 should survive
    for (let i = 0; i < 4; i++) {
      expect(names[i]).toBe(`agent-${i}`);
    }
    // Panes 4–8 should be gone
    for (let i = 4; i < 9; i++) {
      expect(names[i]).toBeUndefined();
    }
  });

  it("trims paneCwds for removed panes when shrinking", () => {
    for (let i = 0; i < 9; i++) {
      useAppStore.getState().setPaneCwd(`t0p${i}`, `/home/user/project-${i}`);
    }
    useAppStore.getState().setTabLayout(0, "1×1");
    const cwds = useAppStore.getState().paneCwds;
    expect(cwds["t0p0"]).toBe("/home/user/project-0");
    for (let i = 1; i < 9; i++) {
      expect(cwds[`t0p${i}`]).toBeUndefined();
    }
  });

  it("trims paneGitInfo for removed panes when shrinking", () => {
    for (let i = 0; i < 4; i++) {
      useAppStore.getState().setPaneGitInfo(`t0p${i}`, { repo: "r", branch: "main", dirty: false });
    }
    useAppStore.getState().setTabLayout(0, "1×1");
    const gitInfo = useAppStore.getState().paneGitInfo;
    expect(gitInfo["t0p0"]).toBeDefined();
    for (let i = 1; i < 4; i++) {
      expect(gitInfo[`t0p${i}`]).toBeUndefined();
    }
  });

  it("does not remove pane data when growing the layout", () => {
    useAppStore.setState({ tabs: [{ name: "ws", layout: "1×1", state: "idle" }] });
    useAppStore.getState().setPaneName(0, 0, "agent-0");
    useAppStore.getState().setPaneCwd("t0p0", "/home/user");
    useAppStore.getState().setTabLayout(0, "3×3");
    expect(useAppStore.getState().paneNames[0][0]).toBe("agent-0");
    expect(useAppStore.getState().paneCwds["t0p0"]).toBe("/home/user");
  });

  it("does not affect pane data for other tabs", () => {
    useAppStore.getState().addTab({ name: "other", layout: "2×2", state: "idle" });
    useAppStore.getState().setPaneName(1, 0, "other-agent");
    useAppStore.getState().setPaneCwd("t1p0", "/other/project");
    // Shrink tab 0 — should not touch tab 1
    useAppStore.getState().setTabLayout(0, "1×1");
    expect(useAppStore.getState().paneNames[1]?.[0]).toBe("other-agent");
    expect(useAppStore.getState().paneCwds["t1p0"]).toBe("/other/project");
  });

  it("handles repeated layout changes correctly", () => {
    for (let i = 0; i < 9; i++) {
      useAppStore.getState().setPaneName(0, i, `agent-${i}`);
    }
    useAppStore.getState().setTabLayout(0, "2×2"); // shrink to 4
    useAppStore.getState().setTabLayout(0, "3×3"); // grow back to 9
    const names = useAppStore.getState().paneNames[0];
    // The 4 surviving panes kept their names; 5–8 were trimmed and are now gone
    for (let i = 0; i < 4; i++) {
      expect(names[i]).toBe(`agent-${i}`);
    }
    for (let i = 4; i < 9; i++) {
      expect(names[i]).toBeUndefined();
    }
  });
});
