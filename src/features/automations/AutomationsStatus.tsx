import { useAppStore } from "@/store";
import { armedSummary, fmtClock } from "./format";

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
      <span className="s" style={{ color: "var(--fg-dim)" }}>
        <i className="off" /> no schedules armed
      </span>
    );
  }
  return (
    <span className="s">
      <i className="warn" /> {count} {count === 1 ? "schedule" : "schedules"} armed
      {nextAt != null && ` · next at ${fmtClock(nextAt)}`}
    </span>
  );
}
