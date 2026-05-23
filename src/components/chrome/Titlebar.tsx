import { Minus, Maximize2, X } from "lucide-react";

interface TitlebarProps {
  workspace?: string;
  meta?: React.ReactNode;
}

const platform = (() => {
  if (typeof navigator === "undefined") return "win";
  const s = (navigator.platform + " " + navigator.userAgent).toLowerCase();
  if (s.includes("mac") || s.includes("darwin")) return "mac";
  return "win";
})();

async function windowAction(action: "close" | "minimize" | "toggleMaximize") {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  if (action === "close") await w.close();
  else if (action === "minimize") await w.minimize();
  else await w.toggleMaximize();
}

function MetaSlot({ meta }: { meta: React.ReactNode }) {
  return (
    <div className="tl-meta">
      {meta ?? (
        <>
          <span>claude <b style={{ color: "var(--success)" }}>● connected</b></span>
          <span>github <b>kevinthelago</b></span>
        </>
      )}
    </div>
  );
}

export function Titlebar({ workspace = "orchestrator · acme/payments", meta }: TitlebarProps) {
  const title = `base-studio-code — ${workspace}`;

  if (platform === "mac") {
    return (
      <div className="titlebar mac">
        <div className="tl-lights">
          <i onClick={() => windowAction("close")} title="Close" />
          <i onClick={() => windowAction("minimize")} title="Minimize" />
          <i onClick={() => windowAction("toggleMaximize")} title="Zoom" />
        </div>
        <div className="tl-title">{title}</div>
        <MetaSlot meta={meta} />
      </div>
    );
  }

  return (
    <div className="titlebar win">
      <div className="tl-title">{title}</div>
      <MetaSlot meta={meta} />
      <div className="tl-controls">
        <button onClick={() => windowAction("minimize")} title="Minimize">
          <Minus size={11} />
        </button>
        <button onClick={() => windowAction("toggleMaximize")} title="Maximize">
          <Maximize2 size={11} />
        </button>
        <button className="tl-close" onClick={() => windowAction("close")} title="Close">
          <X size={11} />
        </button>
      </div>
    </div>
  );
}
