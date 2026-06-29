// The third pane of the planning page (#530/#531): the live UI preview. It renders
// whatever the render-preview pipeline (#531) writes to the store for this project;
// the "render demo" action routes a built-in skeleton through that same pipeline so
// the full path (engine → bundle → store → pane) is verifiable on its own. #533 wires
// the real triggers (the planner's <ui_preview> tag + a watch on .ui-skeleton/).

import { useState, useCallback } from "react";
import { Chip } from "@/shared/ui/data/Chip";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { PreviewFrame, type PreviewStatus } from "../preview/PreviewFrame";
import { StageScreenFrame } from "../preview/StageScreenFrame";
import { dispatchRenderPreview, RENDER_PREVIEW_ID } from "../preview/renderPreview";
import { buildClaudeDesignBrief } from "../preview/claudeDesignBrief";

// Stable empty default so the selector doesn't churn a new array on every store change.
const EMPTY: string[] = [];

const DEMO_FILES: Record<string, string> = {
  "Demo.jsx":
`export default function Demo() {
  return (
    <div style={{ padding: 40, fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1 style={{ color: "#e0a050", margin: 0 }}>Preview pane</h1>
      <p style={{ color: "#bbb", maxWidth: 460, lineHeight: 1.6 }}>
        The render-preview pipeline bundled this skeleton (esbuild-wasm) and rendered it
        in a sandboxed iframe, pulling React from esm.sh. The UI stage will render your
        generated screens here.
      </p>
    </div>
  );
}`,
};

export function PlanPreviewPane({ projectKey, onClose }: { projectKey: string; onClose?: () => void }) {
  const preview = useAppStore((s) => s.stagePreview[projectKey] ?? null);
  const run = useAppStore((s) => s.stageRuns[projectKey]?.[RENDER_PREVIEW_ID]);
  const declared = useAppStore((s) => s.uiScreens[projectKey]) ?? EMPTY;
  const approvedList = useAppStore((s) => s.uiApproved[projectKey]) ?? EMPTY;
  const setUiScreenApproved = useAppStore((s) => s.setUiScreenApproved);
  const status = run?.status ?? "idle";
  const [frameError, setFrameError] = useState<string>("");
  const [briefCopied, setBriefCopied] = useState(false);

  // Per-screen approval (#546): the approve button targets whichever screen is rendered.
  const currentScreen = preview?.screen;
  const currentApproved = !!currentScreen && approvedList.includes(currentScreen);
  const approvedCount = declared.filter((s) => approvedList.includes(s)).length;

  const renderDemo = () => void dispatchRenderPreview({ projectKey, artifacts: DEMO_FILES, entry: "Demo.jsx", mode: "2d" });
  // Manual trigger: read the project's real .ui-skeleton from disk and render it.
  const loadSkeleton = async () => {
    try {
      await safeInvoke("sync_design_to_skeleton", { projectKey }, undefined); // #1373: pull dropped design into the skeleton first
      const files = await invoke<[string, string][]>("read_ui_skeleton", { projectKey });
      if (files.length > 0) await dispatchRenderPreview({ projectKey, artifacts: Object.fromEntries(files), mode: "2d" });
    } catch (e) { setFrameError(String(e)); }
  };
  const onStatus = useCallback((s: PreviewStatus) => { setFrameError(s.status === "error" ? (s.message ?? "") : ""); }, []);

  const statusLabel = status === "running" ? "building…" : frameError ? "error" : status;
  const statusColor = frameError || status === "fail" ? "var(--danger)" : status === "ok" ? "var(--success)" : "var(--fg-dim)";

  return (
    <StageScreenFrame
      label="preview"
      badge={preview && <Chip style={{ fontSize: 9 }}>{preview.mode}</Chip>}
      statusLabel={statusLabel}
      statusColor={statusColor}
      onClose={onClose}
      actions={
        <>
          {/* Approve the screen that's rendered; each approval advances the UI stage (#546). */}
          {preview && currentScreen && (
            <button
              className={currentApproved ? "btn sm" : "btn ghost sm"}
              onClick={() => setUiScreenApproved(projectKey, currentScreen, !currentApproved)}
              title={currentApproved ? `${currentScreen} approved — click to revoke` : `Approve ${currentScreen}`}
              style={currentApproved ? { color: "var(--success)", borderColor: "var(--success)" } : undefined}
            >
              {currentApproved ? "✓ approved" : "approve"}
            </button>
          )}
          {preview && <button className="btn ghost sm" onClick={renderDemo} title="Rebuild">↻</button>}
        </>
      }
      footer={declared.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border-soft)", padding: "8px 12px", maxHeight: 180, overflow: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", marginBottom: 6 }}>
            <span>screens</span>
            <button
              className="btn ghost sm"
              title="Copy a Claude Design prompt for these screens — paste it into Claude Design, then drop the exports into the Drop-files stage"
              onClick={() => {
                void navigator.clipboard?.writeText(buildClaudeDesignBrief(declared));
                setBriefCopied(true);
                setTimeout(() => setBriefCopied(false), 1600);
              }}
            >{briefCopied ? "✓ copied" : "✦ Claude Design brief"}</button>
            <span style={{ flex: 1 }} />
            <span style={{ color: approvedCount === declared.length ? "var(--success)" : "var(--fg-dim)" }}>
              {approvedCount}/{declared.length} approved
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {declared.map((s) => {
              const ok = approvedList.includes(s);
              return (
                <button
                  key={s}
                  className="btn ghost sm"
                  onClick={() => setUiScreenApproved(projectKey, s, !ok)}
                  title={ok ? `${s} approved — click to revoke` : `Approve ${s}`}
                  style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-start", textAlign: "left", fontFamily: "var(--mono)", fontSize: 11 }}
                >
                  <span style={{ color: ok ? "var(--success)" : "var(--fg-dim)" }}>{ok ? "✓" : "○"}</span>
                  <span style={{ color: s === currentScreen ? "var(--accent)" : "var(--fg)" }}>{s}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {status === "fail" ? (
          <div style={{ padding: 16, fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)", whiteSpace: "pre-wrap", overflow: "auto" }}>
            {run?.message || "Preview failed to build."}
          </div>
        ) : preview?.srcDoc ? (
          <PreviewFrame srcDoc={preview.srcDoc} onStatus={onStatus} />
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-muted)" }}>
              {status === "running" ? "Bundling…" : "No preview yet"}
            </div>
            <div className="hint" style={{ maxWidth: 280 }}>
              The UI stage renders generated screens here via the render-preview pipeline.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={loadSkeleton} disabled={status === "running"}>load from skeleton →</button>
              <button className="btn ghost" onClick={renderDemo} disabled={status === "running"}>demo</button>
            </div>
          </div>
        )}
      </div>
    </StageScreenFrame>
  );
}
