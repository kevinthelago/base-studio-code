// Design Studio (#2308 · restructured #2668) — the full-page workbench, the standalone Rail workspace body
// (#2303). It is now a SHELL over three pages the top-bar PILLS navigate between — Preview · Design Studio ·
// Theme Studio — with the always-on designer session docked at the shell level so its PTY survives page
// switches (and so the designer is available on every page, not just the workbench). Kit navigation moved
// into the Design Studio page's own rail; the top bar navigates PAGES, not kits.
//
//   ┌ toolbar ─ [Preview] [Design Studio] [Theme Studio] ───────────────┐
//   │ page (PreviewPage | DesignStudioPage | ThemeStudioPage)           │
//   ├ ─── row-resize handle ─────────────────────────────────────────── ┤
//   │ DesignerTerminal (persistent PTY, resizable)                      │
//   └───────────────────────────────────────────────────────────────────┘
import { useEffect, useState } from "react";
import { useAppStore } from "@/store";
import { DesignerTerminal } from "./DesignerTerminal";
import { DesignStudioPage } from "./pages/DesignStudioPage";
import { PreviewPage } from "./pages/PreviewPage";
import { ThemeStudioPage } from "./pages/ThemeStudioPage";
import { useUiActivity } from "./lib/uiActivity";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { Box } from "@/shared/ui/layout/Box";
import "./designStudio.css";

const PAGES = [
  { key: "preview", label: "Preview" },
  { key: "design", label: "Design Studio" },
  { key: "theme", label: "Theme Studio" },
] as const;
type StudioPage = (typeof PAGES)[number]["key"];

export function DesignStudio() {
  // Default to the workbench so opening the Studio lands where it always did.
  const [page, setPage] = useState<StudioPage>("design");

  // Live-focus (#2525): the designer session is ALWAYS mounted (#2597) at the shell level, so poll its
  // activity stream for the whole Design Studio lifecycle; clear the focus when the studio unmounts.
  useUiActivity(true);
  useEffect(() => () => useAppStore.getState().setAiFocused(null), []);

  // The always-on designer terminal's height (#2624) — a row-resize handle above it; `invert` because the
  // terminal sits AFTER the handle, so dragging up grows it. The page (flex:1) keeps priority.
  const term = useDragResize({ initial: 240, min: 140, max: 560, axis: "y", invert: true });

  return (
    <Box className="ds-root">
      {/* ── top bar — page navigation pills (kit nav is the Design Studio page's rail) ── */}
      <Box className="ds-toolbar ds-topnav">
        {PAGES.map((p) => (
          <Box
            as="button"
            key={p.key}
            className={`ds-pagepill${page === p.key ? " on" : ""}`}
            aria-current={page === p.key}
            onClick={() => setPage(p.key)}
          >
            {p.label}
          </Box>
        ))}
      </Box>

      {/* ── active page (above the persistent terminal) ── */}
      <Box className="ds-pagewrap">
        {page === "preview" && <PreviewPage />}
        {page === "design" && <DesignStudioPage />}
        {page === "theme" && <ThemeStudioPage />}
      </Box>

      {/* ── the always-on designer session, docked at the shell level so the PTY survives page switches ── */}
      <Box className="ds-handle-h" {...term.handleProps} />
      <DesignerTerminal height={term.size} />
    </Box>
  );
}
