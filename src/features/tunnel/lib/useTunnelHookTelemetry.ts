// The hook-telemetry tunnel surface (#937): project the desktop's aggregated hook-fire
// analytics to a paired phone. READ-ONLY — mobile displays the counts but never controls
// hooks (there is no inbound frame). Mounted once at the app root.
//
// The same summary the Hook Analytics tab renders (`aggregateHookTelemetry` over the
// `hooks.log` tail from `bsc logs tail hook`) is pushed whenever the tunnel comes up; the
// relay replays the last push on connect so a freshly-paired phone mirrors it immediately.

import { useEffect } from "react";
import { useAppStore } from "@/store";
import { logsTail } from "@/shared/lib/core/logsBridge";
import { parseHookLog, aggregateHookTelemetry } from "@/features/mcp";
import { tunnelSetHookTelemetry, type HookTelemetryFrame } from "./tunnelClient";
import { log } from "@/shared/lib/core/log";

// Match the Hook Analytics tab's window so the phone shows the same numbers.
const DAYS = 14;

/** Aggregate the hook-fire log into the read-only wire frame the phone renders. Pure over
 *  its inputs so it's unit-testable without Tauri. */
export function toHookTelemetryFrame(logLines: string[], now: Date): HookTelemetryFrame {
  const an = aggregateHookTelemetry(parseHookLog(logLines.join("\n")), now, DAYS);
  return {
    total: an.total,
    blocks: an.blocks,
    allows: an.allows,
    allowRate: an.allowRate,
    daily: an.daily.map((d) => ({ day: d.day, allows: d.allows, blocks: d.blocks })),
    perHook: an.perHook.map((h) => ({ hook: h.hook, event: h.event, fires: h.fires })),
  };
}

export function useTunnelHookTelemetry(): void {
  const tunnelRunning = useAppStore((s) => s.tunnelRunning);

  // Outbound projection — read + aggregate the hook log and push it whenever the tunnel
  // comes up (no-op until a phone is paired; the relay replays the last push on connect).
  useEffect(() => {
    if (!tunnelRunning) return;
    let cancelled = false;
    logsTail("hook", 8000)
      .then((lines) => {
        if (cancelled) return;
        const frame = toHookTelemetryFrame(lines ?? [], new Date());
        return tunnelSetHookTelemetry(frame);
      })
      .catch((e) => log.error(`tunnel: set_hook_telemetry failed: ${e}`));
    return () => {
      cancelled = true;
    };
  }, [tunnelRunning]);
}
