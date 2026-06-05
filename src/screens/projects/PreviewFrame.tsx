// Sandboxed preview iframe (#530). Renders a preview srcdoc in an isolated iframe
// (sandbox="allow-scripts" — script execution + cross-origin module fetch from
// esm.sh, but no access to the host document/origin). Relays the {__preview} ready/
// error signals from the bundle to the parent.

import { useEffect } from "react";

export interface PreviewStatus { status: "ready" | "error"; message?: string }

export function PreviewFrame({ srcDoc, onStatus }: { srcDoc: string | null; onStatus?: (s: PreviewStatus) => void }) {
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data as { __preview?: string; message?: unknown } | null;
      if (!d || typeof d !== "object") return;
      if (d.__preview === "ready") onStatus?.({ status: "ready" });
      else if (d.__preview === "error") onStatus?.({ status: "error", message: String(d.message ?? "") });
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onStatus]);

  if (!srcDoc) return null;
  return (
    <iframe
      title="UI preview"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{ flex: 1, width: "100%", height: "100%", border: "none", background: "var(--bg-canvas)" }}
    />
  );
}
