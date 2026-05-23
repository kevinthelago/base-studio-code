import { PaneShell } from "../components/pane/PaneShell";
import { ConsoleView } from "../components/pane/views/ConsoleView";
import { FilesView } from "../components/pane/views/FilesView";
import { BranchesView } from "../components/pane/views/BranchesView";
import { ChangesView } from "../components/pane/views/ChangesView";
import { LogView } from "../components/pane/views/LogView";
import { useAppStore } from "../store";
import { REVIEW_TURNS, TREE, BRANCHES, HUNKS, COMMITS } from "../data/mock";
import type { ViewKey } from "../components/pane/ViewTabs";

interface PaneCell {
  agent: string;
  status: "run" | "on" | "idle";
  active: ViewKey;
  meta?: string;
  view: React.ReactNode;
}

const CELLS: PaneCell[] = [
  { agent: "@reviewer",   status: "run",  active: "console",
    view: <ConsoleView small turns={REVIEW_TURNS.slice(0, 2)} />, meta: "PR #418" },
  { agent: "@docs",       status: "on",   active: "files",
    view: <FilesView small tree={TREE.slice(0, 10)} active="crates/ws-server/src/tunnel.rs" cwd="~/Code/acme/payments" />, meta: "watch" },
  { agent: "@triager",    status: "run",  active: "changes",
    view: <ChangesView small hunks={HUNKS} />, meta: "WIP" },
  { agent: "@scratch",    status: "on",   active: "branches",
    view: <BranchesView small branches={BRANCHES} />, meta: "" },
  { agent: "@dispatcher", status: "on",   active: "console",
    view: <ConsoleView small withInput={false} turns={[{
      role: "assistant", blocks: [
        { kind: "text",  text: "awaiting webhook routing. 2 in queue." },
        { kind: "tool",  tool: "gh", args: "webhooks recent", ok: true, summary: "12 in 1h" },
      ],
    }]} />, meta: "q:2" },
  { agent: "@db-shell",   status: "idle", active: "console",
    view: <ConsoleView small withInput={false} turns={[{
      role: "assistant", blocks: [{ kind: "text", text: "sqlite session idle. /scan to start." }],
    }]} />, meta: "sqlite" },
  { agent: "@github",     status: "on",   active: "log",
    view: <LogView small commits={COMMITS} />, meta: "main" },
  { agent: "@tunnel-mon", status: "on",   active: "console",
    view: <ConsoleView small withInput={false} turns={[{
      role: "assistant", blocks: [
        { kind: "tool", tool: "ws", args: "ping iPhone-Lina", ok: true, summary: "24ms" },
        { kind: "tool", tool: "ws", args: "ping Pixel-Alex",  ok: true, summary: "61ms" },
        { kind: "text", text: "forwarded 12 frames · 0 dropped" },
      ],
    }]} />, meta: "42 e/s" },
  { agent: "@logs",       status: "on",   active: "console",
    view: <ConsoleView small withInput={false} turns={[{
      role: "assistant", blocks: [{ kind: "text",
        text: "[14:22:08] auto  fired rule=R-02\n[14:22:10] kb    upsert id=blk_9a2c\n[14:22:14] orch  spawn agent=@reviewer pid=8821" }],
    }]} />, meta: "tail" },
];

function PaneAt({ c, i, paneMenuOpenIdx, focusedPaneIdx }: {
  c: PaneCell; i: number; paneMenuOpenIdx: number; focusedPaneIdx: number;
}) {
  return (
    <PaneShell
      agent={c.agent}
      status={c.status}
      repo="acme/payments"
      branch="main"
      dirty
      model="sonnet-4.5"
      available={["console", "files", "branches", "changes", "log"]}
      active={c.active}
      meta={c.meta}
      menuOpen={i === paneMenuOpenIdx}
      focused={i === focusedPaneIdx}
    >
      {c.view}
    </PaneShell>
  );
}

export function ConsoleScreen() {
  const { tabs, activeTabIdx, paneMenuOpenIdx, focusedPaneIdx, fullscreenPaneIdx } = useAppStore();
  const activeTab = tabs[activeTabIdx];
  const [cols, rows] = activeTab.layout.split("×").map(Number);
  const paneCount = cols * rows;

  // Fullscreen: render one pane filling the entire content area
  if (fullscreenPaneIdx >= 0 && fullscreenPaneIdx < paneCount) {
    const c = CELLS[fullscreenPaneIdx];
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 10 }}>
        <PaneAt c={c} i={fullscreenPaneIdx} paneMenuOpenIdx={paneMenuOpenIdx} focusedPaneIdx={focusedPaneIdx} />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        className="console-grid"
        style={{
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows:    `repeat(${rows}, 1fr)`,
        }}
      >
        {CELLS.slice(0, paneCount).map((c, i) => (
          <PaneAt key={i} c={c} i={i} paneMenuOpenIdx={paneMenuOpenIdx} focusedPaneIdx={focusedPaneIdx} />
        ))}
      </div>
    </div>
  );
}
