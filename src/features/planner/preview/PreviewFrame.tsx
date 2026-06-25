// Sandboxed preview iframe (#530). Renders a preview srcdoc in an isolated iframe
// (sandbox="allow-scripts" — script execution + cross-origin module fetch from
// esm.sh, but no access to the host document/origin). Relays the {__preview} ready/
// error signals from the bundle to the parent.

import { useEffect, useRef } from "react";

export interface PreviewStatus { status: "ready" | "error"; message?: string }

export function PreviewFrame({ srcDoc, onStatus }: { srcDoc: string | null; onStatus?: (s: PreviewStatus) => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      // Trust ONLY messages from THIS preview iframe (js/missing-origin-check, #1011). The
      // iframe is sandboxed WITHOUT allow-same-origin, so it runs in an opaque origin and every
      // such frame reports `e.origin === "null"` — origin alone can't tell ours apart from any
      // other sandboxed frame on the page. The source window's identity can, so gate on it.
      if (e.source !== frameRef.current?.contentWindow) return;
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
      ref={frameRef}
      title="UI preview"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{ flex: 1, width: "100%", height: "100%", border: "none", background: "var(--bg-canvas)" }}
    />
  );
}
