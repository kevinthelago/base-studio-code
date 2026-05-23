interface TitlebarProps {
  workspace?: string;
  meta?: React.ReactNode;
}

async function windowAction(action: "close" | "minimize" | "toggleMaximize") {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  if (action === "close") await w.close();
  else if (action === "minimize") await w.minimize();
  else await w.toggleMaximize();
}

export function Titlebar({
  workspace = "orchestrator · acme/payments",
  meta,
}: TitlebarProps) {
  return (
    <div className="titlebar">
      <div className="tl-title">base-studio-code — {workspace}</div>
      <div className="tl-meta">
        {meta ?? (
          <>
            <span>
              claude <b style={{ color: "var(--success)" }}>● connected</b>
            </span>
            <span>
              github <b>kevinthelago</b>
            </span>
          </>
        )}
      </div>
      <div className="tl-controls">
        <button onClick={() => windowAction("minimize")} title="Minimize">—</button>
        <button onClick={() => windowAction("toggleMaximize")} title="Maximize">□</button>
        <button className="tl-close" onClick={() => windowAction("close")} title="Close">✕</button>
      </div>
    </div>
  );
}
