import { useAppStore } from "@/store";
import { armedSummary, fmtClock } from "./format";
import { Box } from "@/shared/ui/layout/Box";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";

/**
 * Live armed-schedules summary for the app status bar (Automations page) — replaces the
 * old hardcoded "4 schedules armed · next at 02:00" mock. Reads the real automations and
 * shows how many are armed + the soonest next run.
 */
export function AutomationsStatus() {
  const automations = useAppStore((s) => s.automations);
  const { count, nextAt } = armedSummary(automations);

  if (count === 0) {
    return (
      <Box as="span" className="s" style={{ color: "var(--fg-dim)" }}>
        <StatusDot color="var(--fg-dim)" size={7} /> no schedules armed
      </Box>
    );
  }
  return (
    <Box as="span" className="s">
      <StatusDot color="var(--accent)" size={7} /> {count} {count === 1 ? "schedule" : "schedules"} armed
      {nextAt != null && ` · next at ${fmtClock(nextAt)}`}
    </Box>
  );
}
