// The third pane of the planning page (#530): a live UI preview. Bundles a skeleton
// (esbuild-wasm) → sandboxed iframe (previewBundle). #531 feeds it the real skeleton
// from the render-preview pipeline; here it also renders a built-in demo so the
// transport is verifiable on its own.

import { useState, useEffect, useCallback } from "react";
import { bundleSkeleton, buildPreviewSrcDoc } from "./previewBundle";
import { PreviewFrame, type PreviewStatus } from "./PreviewFrame";

export interface PreviewSkeleton { files: Record<string, string>; entry: string; label?: string }

const DEMO_SKELETON: PreviewSkeleton = {
  label: "demo",
  entry: "Demo.jsx",
  files: {
    "Demo.jsx":
`export default function Demo() {
  return (
    <div style={{ padding: 40, fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1 style={{ color: "#e0a050", margin: 0 }}>Preview pane</h1>
      <p style={{ color: "#bbb", maxWidth: 460, lineHeight: 1.6 }}>
        esbuild-wasm bundled this in the WebView and rendered it in a sandboxed iframe,
        pulling React from esm.sh. The UI stage will render your generated screens here.
      </p>
    </div>
  );
}`,
  },
};

type Phase = "idle" | "building" | "ready" | "error";

export function PlanPreviewPane({ skeleton, onClose }: { skeleton?: PreviewSkeleton | null; onClose?: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");
  const [active, setActive] = useState<PreviewSkeleton | null>(skeleton ?? null);

  const run = useCallback(async (sk: PreviewSkeleton) => {
    setPhase("building");
    setMessage("");
    setActive(sk);
    try {
      const js = await bundleSkeleton(sk.files, sk.entry);
      setSrcDoc(buildPreviewSrcDoc(js));
    } catch (e) {
      setSrcDoc(null);
      setPhase("error");
      setMessage(String(e));
    }
  }, []);

  // Re-bundle when the incoming skeleton changes (the pipeline feeds this in #531).
  useEffect(() => {
    if (skeleton) void run(skeleton);
  }, [skeleton, run]);

  const onStatus = useCallback((s: PreviewStatus) => {
    setPhase(s.status === "ready" ? "ready" : "error");
    if (s.status === "error") setMessage(s.message ?? "");
  }, []);

  return (
    <section style={{ flex: "0 0 auto", width: 420, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", borderLeft: "1px solid var(--border-soft)", background: "var(--bg-panel)" }}>
      {/* header */}
      <div style={{
        padding: "10px 14px", borderBottom: "1px solid var(--border-soft)",
        display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
      }}>
        <span style={{ color: "var(--accent)" }}>▸ preview</span>
        {active?.label && <span style={{ color: "var(--fg-dim)" }}>{active.label}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: phase === "error" ? "var(--danger)" : phase === "ready" ? "var(--success)" : "var(--fg-dim)" }}>
          {phase === "building" ? "building…" : phase}
        </span>
        {active && (
          <button className="btn ghost sm" onClick={() => run(active)} title="Rebuild">↻</button>
        )}
        {onClose && <button className="btn ghost sm" onClick={onClose} title="Close preview">✕</button>}
      </div>

      {/* body */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, position: "relative" }}>
        {phase === "error" ? (
          <div style={{ padding: 16, fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)", whiteSpace: "pre-wrap", overflow: "auto" }}>
            {message || "Preview failed to build."}
          </div>
        ) : srcDoc ? (
          <PreviewFrame srcDoc={srcDoc} onStatus={onStatus} />
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-muted)" }}>
              {phase === "building" ? "Bundling…" : "No preview yet"}
            </div>
            <div className="hint" style={{ maxWidth: 280 }}>
              The UI stage renders generated screens here. Try the transport with a demo:
            </div>
            <button className="btn" onClick={() => run(DEMO_SKELETON)} disabled={phase === "building"}>render demo →</button>
          </div>
        )}
      </div>
    </section>
  );
}
