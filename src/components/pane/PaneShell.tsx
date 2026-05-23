import { useState, useRef, useEffect } from "react";
import { ChevronDown, GitBranch, Menu } from "lucide-react";
import { VIEW_DEFS, type ViewKey } from "./ViewTabs";
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
  focused?: boolean;
  onViewChange?: (view: ViewKey) => void;
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
  focused = false,
  onViewChange,
  children,
}: PaneShellProps) {
  const [viewOpen, setViewOpen] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!viewOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (!viewRef.current?.contains(e.target as Node)) setViewOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [viewOpen]);

  const statusColor =
    status === "idle" ? "var(--fg-dim)"
    : status === "run" ? "var(--accent)"
    : "var(--success)";

  const { Icon: ViewIcon, label: viewLabel } = VIEW_DEFS[active];

  return (
    <div className={focused ? "pane focused" : "pane"} style={{
      height: "100%",
      display: "flex", flexDirection: "column",
      position: "relative",
      zIndex: menuOpen || viewOpen ? 10 : 1,
    }}>
      {/* Head */}
      <div style={{
        height: 32, flex: "0 0 32px", padding: "0 8px 0 6px",
        display: "flex", alignItems: "center", gap: 6,
        background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)",
      }}>

        {/* View selector dropdown */}
        <div ref={viewRef} style={{ position: "relative", flex: "0 0 auto" }}>
          <button
            onClick={() => setViewOpen(!viewOpen)}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "0 7px", height: 22, borderRadius: 4,
              background: viewOpen ? "var(--bg-canvas)" : "transparent",
              border: `1px solid ${viewOpen ? "var(--accent-dim)" : "var(--border-soft)"}`,
              color: viewOpen ? "var(--accent)" : "var(--fg-muted)",
              fontFamily: "var(--mono)", fontSize: 10.5,
              cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            <ViewIcon size={11} />
            <span>{viewLabel}</span>
            <ChevronDown size={9} style={{ opacity: 0.6 }} />
          </button>

          {viewOpen && (
            <div style={{
              position: "absolute", top: "calc(100% + 4px)", left: 0,
              zIndex: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border-soft)",
              borderRadius: "var(--r-md)",
              minWidth: 170,
              boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
              overflow: "hidden",
              fontFamily: "var(--mono)",
            }}>
              {available.map((k) => {
                const { Icon, label, hotkey } = VIEW_DEFS[k];
                const on = k === active;
                return (
                  <div
                    key={k}
                    onClick={() => { onViewChange?.(k); setViewOpen(false); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "6px 10px",
                      cursor: "pointer",
                      background: on ? "color-mix(in oklch, var(--accent), transparent 88%)" : "transparent",
                      color: on ? "var(--accent)" : "var(--fg-muted)",
                    }}
                    onMouseEnter={(e) => {
                      if (!on) (e.currentTarget as HTMLDivElement).style.background = "var(--bg-elev)";
                    }}
                    onMouseLeave={(e) => {
                      if (!on) (e.currentTarget as HTMLDivElement).style.background = "transparent";
                    }}
                  >
                    <span style={{ width: 14, display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 14px" }}>
                      <Icon size={12} />
                    </span>
                    <span style={{ flex: 1, fontSize: 10.5 }}>{label}</span>
                    <span style={{ fontSize: 9.5, color: "var(--fg-dim)" }}>{hotkey}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Status dot */}
        <span style={{
          width: 7, height: 7, borderRadius: "50%", background: statusColor,
          animation: status === "run" ? "pulse 1.4s ease-in-out infinite" : "none",
          flex: "0 0 7px",
        }} />

        {/* Agent name */}
        <span style={{
          fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "0 1 auto",
        }}>{agent}</span>

        {/* Repo / cwd / meta */}
        <div style={{
          flex: 1, minWidth: 0,
          display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6,
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {repo ? (
            <>
              <span style={{ color: "var(--info)", display: "flex", alignItems: "center", gap: 3 }}>
                <GitBranch size={10} /> {branch}
              </span>
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
          cursor: "pointer", flex: "0 0 22px",
        }}>
          <Menu size={12} />
        </button>
      </div>

      {banner}

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
