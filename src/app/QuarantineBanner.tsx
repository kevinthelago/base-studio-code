import { ShieldAlert } from "lucide-react";
import { useAppStore } from "@/store";
import { Banner } from "@/shared/ui/Banner";

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
    <>
      {entries.map(([paneId, info]) => (
        <Banner
          key={paneId}
          variant="bar"
          tone="danger"
          lead={<ShieldAlert size={15} style={{ color: "var(--red, #d4554f)", flexShrink: 0 }} />}
          onDismiss={() => clearQuarantine(paneId)}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <b>Worker quarantined</b> — stream <b>{info.streamId}</b> ({paneId}) was paused: {info.summary}.
            Review before relaunching.
          </span>
        </Banner>
      ))}
    </>
  );
}
