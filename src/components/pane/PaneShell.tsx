import { ViewTabs, type ViewKey } from "./ViewTabs";
import { HamburgerMenu, type ModelId } from "./HamburgerMenu";

export type PaneStatus = "run" | "on" | "idle";

interface PaneShellProps {
  agent: string;
  status?: PaneStatus;
  meta?: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  dirty?: boolean;
  model?: ModelId;
  available?: ViewKey[];
  active?: ViewKey;
  banner?: React.ReactNode;
  menuOpen?: boolean;
  children: React.ReactNode;
}

export function PaneShell({
  agent,
  status = "run",
  meta,
  cwd,
  repo,
  branch,
  dirty,
  model = "sonnet-4.5",
  available = ["console", "files"],
  active = "console",
  banner,
  menuOpen = false,
  children,
}: PaneShellProps) {
  const statusColor =
    status === "idle" ? "var(--fg-dim)"
    : status === "run" ? "var(--accent)"
    : "var(--success)";

  return (
    <div className="pane focused" style={{
      height: "100%",
      display: "flex", flexDirection: "column",
      position: "relative",
      zIndex: menuOpen ? 5 : 1,
    }}>
      {/* Head */}
      <div style={{
        height: 32, flex: "0 0 32px", padding: "0 8px 0 10px",
        display: "flex", alignItems: "center", gap: 8,
        background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)",
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: "50%", background: statusColor,
          animation: status === "run" ? "pulse 1.4s ease-in-out infinite" : "none",
          flex: "0 0 7px",
        }} />
        <span style={{
          fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "0 1 auto",
        }}>{agent}</span>

        <div style={{
          flex: 1, minWidth: 0,
          display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6,
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {repo ? (
            <>
              <span style={{ color: "var(--info)" }}>⎇ {branch}</span>
              {dirty && <span style={{ color: "var(--danger)" }}>●</span>}
              <span style={{ color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis" }}>{repo}</span>
            </>
          ) : (
            <span style={{ color: "var(--fg-dim)" }}>cwd: {cwd}</span>
          )}
          {meta && (
            <>
              <span style={{ color: "var(--fg-dim)" }}>·</span>
              <span>{meta}</span>
            </>
          )}
        </div>

        {/* Hamburger */}
        <button title="Pane menu" style={{
          width: 22, height: 22, borderRadius: 4,
          border: "1px solid " + (menuOpen ? "var(--accent-dim)" : "transparent"),
          background: menuOpen ? "var(--bg-canvas)" : "transparent",
          color: menuOpen ? "var(--accent)" : "var(--fg-muted)",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", fontSize: 12, lineHeight: "1", flex: "0 0 22px",
        }}>☰</button>
      </div>

      {banner}
      <ViewTabs active={active} available={available} />

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {children}
      </div>

      {menuOpen && (
        <HamburgerMenu
          agent={agent} repo={repo} branch={branch}
          model={model} active={active} available={available}
        />
      )}
    </div>
  );
}
