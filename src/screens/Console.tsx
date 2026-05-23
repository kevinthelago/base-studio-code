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
  meta?: string;
}

const CELLS: PaneCell[] = [
  { agent: "@reviewer",   status: "run",  meta: "PR #418" },
  { agent: "@docs",       status: "on",   meta: "watch"   },
  { agent: "@triager",    status: "run",  meta: "WIP"     },
  { agent: "@scratch",    status: "on",   meta: ""        },
  { agent: "@dispatcher", status: "on",   meta: "q:2"     },
  { agent: "@db-shell",   status: "idle", meta: "sqlite"  },
  { agent: "@github",     status: "on",   meta: "main"    },
  { agent: "@tunnel-mon", status: "on",   meta: "42 e/s"  },
  { agent: "@logs",       status: "on",   meta: "tail"    },
];

// Per-pane console content so each agent has distinct chat history
const PANE_CONSOLE: React.ReactNode[] = [
  <ConsoleView small turns={REVIEW_TURNS.slice(0, 2)} />,
  <ConsoleView small withInput={false} turns={[{ role: "assistant", blocks: [{ kind: "text", text: "Watching for file changes…" }] }]} />,
  <ConsoleView small withInput={false} turns={[{ role: "assistant", blocks: [{ kind: "text", text: "Triaging issue #421." }, { kind: "tool", tool: "gh", args: "issue list", ok: true, summary: "8 open" }] }]} />,
  <ConsoleView small withInput={false} turns={[{ role: "assistant", blocks: [{ kind: "text", text: "On branch feat/tunnel. Nothing to push." }] }]} />,
  <ConsoleView small withInput={false} turns={[{ role: "assistant", blocks: [{ kind: "text", text: "awaiting webhook routing. 2 in queue." }, { kind: "tool", tool: "gh", args: "webhooks recent", ok: true, summary: "12 in 1h" }] }]} />,
  <ConsoleView small withInput={false} turns={[{ role: "assistant", blocks: [{ kind: "text", text: "sqlite session idle. /scan to start." }] }]} />,
  <ConsoleView small withInput={false} turns={[{ role: "assistant", blocks: [{ kind: "text", text: "Monitoring GitHub events on main." }] }]} />,
  <ConsoleView small withInput={false} turns={[{ role: "assistant", blocks: [{ kind: "tool", tool: "ws", args: "ping iPhone-Lina", ok: true, summary: "24ms" }, { kind: "tool", tool: "ws", args: "ping Pixel-Alex", ok: true, summary: "61ms" }, { kind: "text", text: "forwarded 12 frames · 0 dropped" }] }]} />,
  <ConsoleView small withInput={false} turns={[{ role: "assistant", blocks: [{ kind: "text", text: "[14:22:08] auto  fired rule=R-02\n[14:22:10] kb    upsert id=blk_9a2c\n[14:22:14] orch  spawn agent=@reviewer pid=8821" }] }]} />,
];

function renderView(viewKey: ViewKey, idx: number): React.ReactNode {
  switch (viewKey) {
    case "console":  return PANE_CONSOLE[idx] ?? <ConsoleView small turns={[]} />;
    case "files":    return <FilesView small tree={TREE.slice(0, 10)} active="crates/ws-server/src/tunnel.rs" cwd="~/Code/acme/payments" />;
    case "branches": return <BranchesView small branches={BRANCHES} />;
    case "changes":  return <ChangesView small hunks={HUNKS} />;
    case "log":      return <LogView small commits={COMMITS} />;
  }
}

function PaneAt({ c, i, paneMenuOpenIdx, focusedPaneIdx, view, onViewChange }: {
  c: PaneCell; i: number; paneMenuOpenIdx: number; focusedPaneIdx: number;
  view: ViewKey; onViewChange: (v: ViewKey) => void;
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
      active={view}
      meta={c.meta}
      menuOpen={i === paneMenuOpenIdx}
      focused={i === focusedPaneIdx}
      onViewChange={onViewChange}
    >
      {renderView(view, i)}
    </PaneShell>
  );
}

export function ConsoleScreen() {
  const {
    tabs, activeTabIdx, paneMenuOpenIdx,
    focusedPaneIdx, fullscreenPaneIdx,
    paneViews, setPaneView,
  } = useAppStore();

  const activeTab = tabs[activeTabIdx];
  const [cols, rows] = activeTab.layout.split("×").map(Number);
  const paneCount = cols * rows;

  if (fullscreenPaneIdx >= 0 && fullscreenPaneIdx < paneCount) {
    const c = CELLS[fullscreenPaneIdx];
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 10 }}>
        <PaneAt
          c={c} i={fullscreenPaneIdx}
          paneMenuOpenIdx={paneMenuOpenIdx} focusedPaneIdx={focusedPaneIdx}
          view={paneViews[fullscreenPaneIdx]}
          onViewChange={(v) => setPaneView(fullscreenPaneIdx, v)}
        />
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
          <PaneAt
            key={i} c={c} i={i}
            paneMenuOpenIdx={paneMenuOpenIdx} focusedPaneIdx={focusedPaneIdx}
            view={paneViews[i]}
            onViewChange={(v) => setPaneView(i, v)}
          />
        ))}
      </div>
    </div>
  );
}
