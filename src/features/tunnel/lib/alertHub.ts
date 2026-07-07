// Alert hub (#2498) — the one place alert candidates from every source (the coord pump, the
// focus queue, the planner's gate/turn transitions) converge. Folds them into the capped
// rolling inbox (pure model: alerts.ts), publishes the inbox as the `alerts` store_state
// domain, and fires one FCM push per FRESH alert via the thin `tunnel_emit_alert` command —
// so a backgrounded/quit phone is notified even while off the relay.
//
// The hub is a factory (`createAlertHub`) so the fold→publish→push flow is testable with
// injected transports; the app-wide instance below binds the real publisher + push command.

import { foldAlerts, alertPushFields, type AlertEvent } from "./alerts";
import { buildAlertsPayload } from "./storeProjections";
import { publishTunnelDomain } from "./tunnelDomains";
import { tunnelEmitAlert } from "./tunnelClient";
import { log } from "@/shared/lib/core/log";

export interface AlertHub {
  /** Fold candidates into the inbox; publish + push whatever is genuinely new. */
  record(candidates: ReadonlyArray<AlertEvent>): void;
  /** Fold + publish WITHOUT pushing — for the first coord-log read after the relay starts,
   *  so the historical log seeds the mobile inbox without firing a burst of stale FCM
   *  notifications. Everything folded here is known, so a later `record` won't push it. */
  seed(candidates: ReadonlyArray<AlertEvent>): void;
  /** The current inbox (newest last). Exposed for tests/diagnostics. */
  inbox(): ReadonlyArray<AlertEvent>;
}

export function createAlertHub(deps: {
  publish: (payload: unknown) => void;
  push: (alert: AlertEvent, title: string, body: string) => Promise<void>;
  onError?: (err: unknown) => void;
}): AlertHub {
  let inbox: ReadonlyArray<AlertEvent> = [];
  const onError = deps.onError ?? (() => {});
  const fold = (candidates: ReadonlyArray<AlertEvent>, push: boolean): void => {
    const { inbox: next, fresh } = foldAlerts(inbox, candidates);
    if (fresh.length === 0) return;
    inbox = next;
    deps.publish(buildAlertsPayload(inbox));
    if (!push) return;
    for (const a of fresh) {
      const { title, body } = alertPushFields(a);
      deps.push(a, title, body).catch(onError);
    }
  };
  return {
    record: (candidates) => fold(candidates, true),
    seed: (candidates) => fold(candidates, false),
    inbox: () => inbox,
  };
}

const hub = createAlertHub({
  publish: (payload) => publishTunnelDomain("alerts", payload),
  push: (a, title, body) => tunnelEmitAlert(a.kind, title, body, a.paneId ?? null, a.at),
  onError: (e) => log.error(`tunnel: alert push failed: ${e}`),
});

/** Record alert candidates on the app-wide hub. Callers gate on the tunnel being live —
 *  alerts are a mobile-companion feature (the desktop has its own inbox surfaces). */
export function recordTunnelAlerts(candidates: ReadonlyArray<AlertEvent>): void {
  hub.record(candidates);
}

/** Seed the app-wide hub without pushing (the first coord-log read — see {@link AlertHub.seed}). */
export function seedTunnelAlerts(candidates: ReadonlyArray<AlertEvent>): void {
  hub.seed(candidates);
}
