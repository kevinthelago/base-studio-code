// The third pane of the planning page (#530/#531): the live UI preview. It renders
// whatever the render-preview pipeline (#531) writes to the store for this project;
// the "render demo" action routes a built-in skeleton through that same pipeline so
// the full path (engine → bundle → store → pane) is verifiable on its own. #533 wires
// the real triggers (the planner's <ui_preview> tag + a watch on .ui-skeleton/).

import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import { PreviewFrame, type PreviewStatus } from "./PreviewFrame";
import { dispatchRenderPreview, RENDER_PREVIEW_ID } from "./renderPreview";

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
  const run = useAppStore((s) => s.stagePipelineRuns[projectKey]?.[RENDER_PREVIEW_ID]);
  const status = run?.status ?? "idle";
  const [frameError, setFrameError] = useState<string>("");

  const renderDemo = () => void dispatchRenderPreview({ projectKey, artifacts: DEMO_FILES, entry: "Demo.jsx", mode: "2d" });
  // Manual trigger: read the project's real .ui-skeleton from disk and render it.
  const loadSkeleton = async () => {
    try {
      const files = await invoke<[string, string][]>("read_ui_skeleton", { projectKey });
      if (files.length > 0) await dispatchRenderPreview({ projectKey, artifacts: Object.fromEntries(files), mode: "2d" });
    } catch (e) { setFrameError(String(e)); }
  };
  const onStatus = useCallback((s: PreviewStatus) => { setFrameError(s.status === "error" ? (s.message ?? "") : ""); }, []);

  const statusLabel = status === "running" ? "building…" : frameError ? "error" : status;
  const statusColor = frameError || status === "fail" ? "var(--danger)" : status === "ok" ? "var(--success)" : "var(--fg-dim)";

  return (
    <section style={{ flex: "0 0 auto", width: 420, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", borderLeft: "1px solid var(--border-soft)", background: "var(--bg-panel)" }}>
      <div style={{
        padding: "10px 14px", borderBottom: "1px solid var(--border-soft)",
        display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
      }}>
        <span style={{ color: "var(--accent)" }}>▸ preview</span>
        {preview && <span className="tag" style={{ fontSize: 9 }}>{preview.mode}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: statusColor }}>{statusLabel}</span>
        {preview && <button className="btn ghost sm" onClick={renderDemo} title="Rebuild">↻</button>}
        {onClose && <button className="btn ghost sm" onClick={onClose} title="Close preview">✕</button>}
      </div>

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
    </section>
  );
}
