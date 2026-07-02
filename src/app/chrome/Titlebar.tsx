import { Minus, Maximize2, X } from "lucide-react";
import { Box } from "@/shared/ui/layout/Box";

interface TitlebarProps {
  workspace?: string;
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

export function Titlebar({ workspace = "base-studio-code" }: TitlebarProps) {
  const title = `base-studio-code — ${workspace}`;

  if (platform === "mac") {
    return (
      <Box className="titlebar mac">
        <Box className="tl-lights">
          <i onClick={() => windowAction("close")} title="Close" />
          <i onClick={() => windowAction("minimize")} title="Minimize" />
          <i onClick={() => windowAction("toggleMaximize")} title="Zoom" />
        </Box>
        <Box className="tl-title">{title}</Box>
      </Box>
    );
  }

  return (
    <Box className="titlebar win">
      <Box className="tl-title">{title}</Box>
      <Box className="tl-controls">
        {/* eslint-disable-next-line no-restricted-syntax -- bespoke window control (styled by the `.titlebar .tl-controls button` CSS, not the .btn kit) */}
        <button onClick={() => windowAction("minimize")} title="Minimize">
          <Minus size={11} />
        </button>
        {/* eslint-disable-next-line no-restricted-syntax -- bespoke window control (styled by the `.titlebar .tl-controls button` CSS, not the .btn kit) */}
        <button onClick={() => windowAction("toggleMaximize")} title="Maximize">
          <Maximize2 size={11} />
        </button>
        {/* eslint-disable-next-line no-restricted-syntax -- bespoke window close control (styled by the `.tl-close` CSS, not the .btn kit) */}
        <button className="tl-close" onClick={() => windowAction("close")} title="Close">
          <X size={11} />
        </button>
      </Box>
    </Box>
  );
}
