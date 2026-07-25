// useCoordAnnouncer (#3770, a11y epic #2725) — announces NEW coordination events to the screen reader.
// App-level (the shell may import features); reuses the tunnel's `coordAlerts` derivation, whose `text`
// is already the human line ("api-stream paused and is waiting for you"), so the spoken status matches
// the CoordinatorInbox + the mobile alerts. It speaks the STRUCTURED events, never the raw terminal
// stream (screen readers drown in that). The mount backlog is seeded SILENT so a reader isn't buried in
// history on launch — only events that arrive after are announced.
import { useEffect, useRef } from "react";
import { useCoordLog } from "@/shared/lib/fleet/useCoordLog";
import { coordAlerts } from "@/features/tunnel";
import { announce } from "@/shared/lib/a11y/announcer";

export function useCoordAnnouncer(): void {
  const { state } = useCoordLog();
  const seen = useRef<Set<string>>(new Set());
  const seeded = useRef(false);

  useEffect(() => {
    const alerts = coordAlerts(state);
    if (!seeded.current) {
      // First read after mount: remember the existing backlog without speaking it.
      seeded.current = true;
      for (const a of alerts) seen.current.add(a.id);
      return;
    }
    for (const a of alerts) {
      if (seen.current.has(a.id)) continue;
      seen.current.add(a.id);
      // `fleet-failed` is the one that can't wait (a stalled chain); everything else queues politely.
      announce(a.text, { assertive: a.kind === "fleet-failed" });
    }
  }, [state]);
}
