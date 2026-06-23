import { ShieldAlert, X } from "lucide-react";
import { useAppStore } from "../store";

/**
 * Warden quarantine banner (#1102). When the warden hard-pauses a worker that drifted off its
 * plan (PTY killed — possible prompt injection / hijack), surface it loudly here so the user can't
 * miss it (it's also pushed to a paired phone). One row per quarantined pane with its trip summary;
 * dismissing a row clears the quarantine flag (the user's explicit acknowledgement). The worker's
 * PTY was already stopped, so this is acknowledge-and-relaunch-when-ready, not auto-resume.
 */
export function QuarantineBanner() {
  const quarantinedPanes = useAppStore((s) => s.quarantinedPanes);
  const clearQuarantine = useAppStore((s) => s.clearQuarantine);

  const entries = Object.entries(quarantinedPanes);
  if (entries.length === 0) return null;

  return (
    <div
      style={{
        display: "flex", flexDirection: "column",
        background: "color-mix(in oklch, var(--red, #d4554f), transparent 86%)",
        borderBottom: "1px solid var(--border-soft)",
        fontFamily: "var(--sans)", fontSize: 12, lineHeight: 1.5, color: "var(--fg)",
      }}
    >
      {entries.map(([paneId, info]) => (
        <div key={paneId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 14px" }}>
          <ShieldAlert size={15} style={{ color: "var(--red, #d4554f)", flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <b>Worker quarantined</b> — stream <b>{info.streamId}</b> ({paneId}) was paused: {info.summary}.
            Review before relaunching.
          </span>
          <button
            onClick={() => clearQuarantine(paneId)}
            aria-label="Dismiss quarantine"
            style={{ display: "inline-flex", background: "transparent", border: "none", cursor: "pointer", color: "var(--fg-muted)", padding: 4 }}
          >
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
