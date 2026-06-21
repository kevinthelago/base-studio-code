import { useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { useAppStore } from "../store";

/**
 * Crash-recovery banner (#1041). After an UNCLEAN shutdown — a crash / kill / power loss / force-quit
 * detected by the session-lock marker surviving the previous run (`was_unclean_shutdown`) — offer a
 * one-click restore of the Claude sessions that were running, each resuming its prior conversation
 * (`claude --continue`, staggered). A CLEAN quit never shows this; sessions stay dormant.
 *
 * Hidden when silent auto-resume already handled the crash (`autoResumeClaude` on) or there's nothing
 * to restore. Dismissable; one-shot per app run.
 */
export function CrashRecoveryBanner() {
  const uncleanShutdown = useAppStore((s) => s.uncleanShutdown);
  const autoResumeClaude = useAppStore((s) => s.autoResumeClaude);
  const paneWasClaude = useAppStore((s) => s.paneWasClaude);
  const restoreSessionsFromCrash = useAppStore((s) => s.restoreSessionsFromCrash);
  const [hidden, setHidden] = useState(false);

  const count = Object.keys(paneWasClaude).filter((p) => paneWasClaude[p]).length;
  // Silent auto-resume already relaunches on a crash when the user opted in — no banner needed then.
  if (hidden || !uncleanShutdown || autoResumeClaude || count === 0) return null;

  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "7px 14px",
        background: "color-mix(in oklch, var(--accent), transparent 86%)",
        borderBottom: "1px solid var(--border-soft)",
        fontFamily: "var(--sans)", fontSize: 12, lineHeight: 1.5, color: "var(--fg)",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        Your last session ended unexpectedly —{" "}
        <b>restore {count} session{count === 1 ? "" : "s"}</b> from where {count === 1 ? "it" : "they"} left off?
      </span>
      <button
        className="btn primary"
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        onClick={() => { restoreSessionsFromCrash(); setHidden(true); }}
      >
        <RotateCcw size={13} /> Restore {count}
      </button>
      <button
        onClick={() => setHidden(true)}
        aria-label="Dismiss"
        style={{ display: "inline-flex", background: "transparent", border: "none", cursor: "pointer", color: "var(--fg-muted)", padding: 4 }}
      >
        <X size={15} />
      </button>
    </div>
  );
}
