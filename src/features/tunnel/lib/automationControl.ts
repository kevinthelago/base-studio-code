// Pure helpers for the automations tunnel surface (#937): project a store Automation to
// the wire frame, and decide whether a phone's arm/disarm request is allowed. The desktop
// owns schedule validity — a phone can arm/disarm/run, but an invalid cron is rejected
// here rather than silently armed (and the phone never runs schedules itself).

import { isValidCron } from "@/features/automations/lib/cron";
import type { Automation, AutomationWhen } from "@/features/automations/lib/scheduler";
import type { AutomationFrame } from "./tunnelClient";

/** A compact, human-readable schedule string for the phone (cron expr, or "every day · 09:00"). */
export function whenExpr(when: AutomationWhen): string {
  if (when.kind === "cron") return when.expr;
  return `every ${when.every}${when.every !== "minute" ? " · " + when.at : ""}`;
}

/** Project one automation to its read-only wire frame. */
export function automationToFrame(a: Automation): AutomationFrame {
  return {
    id: a.id,
    name: a.name,
    armed: a.armed,
    whenExpr: whenExpr(a.when),
    lastRunAt: a.lastRunAt,
    nextRunAt: a.nextRunAt,
    lastStatus: a.runs[0]?.status ?? null,
  };
}

export type ArmDecision =
  | { ok: true; id: string; armed: boolean }
  | { ok: false; id: string; name: string; error: string };

/**
 * Decide a phone's arm/disarm request:
 *  - unknown id → rejected.
 *  - arming a cron automation with an invalid expression → rejected (the schedule would
 *    never fire, and the desktop is the source of truth for validity).
 *  - disarming, or arming a valid schedule → allowed.
 */
export function planArm(a: Automation | undefined, id: string, armed: boolean): ArmDecision {
  if (!a) return { ok: false, id, name: id, error: "unknown automation" };
  if (armed && a.when.kind === "cron" && !isValidCron(a.when.expr)) {
    return { ok: false, id, name: a.name, error: `invalid cron expression: ${a.when.expr}` };
  }
  return { ok: true, id, armed };
}
