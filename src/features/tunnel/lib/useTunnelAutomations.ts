// The automations tunnel surface (#937): project the automations store to a paired phone
// and accept its arm / disarm / run-now control. Mounted once at the app root.
//
// Outbound — push the list (id/name/schedule/armed/next-run/last-status) whenever it
//   changes; the relay replays the last push on connect.
// Inbound — route the phone's control through the SAME store + scheduler the desktop uses:
//   arm/disarm validates the cron (an invalid one is rejected back to the phone, never
//   silently armed); run-now fires the automation through the shared dispatch. The phone
//   never runs schedules itself — it only asks the desktop to.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { dispatchAutomation } from "@/features/automations/lib/dispatch";
import { automationToFrame, planArm } from "./automationControl";
import { tunnelSetAutomations, tunnelAutomationFailed } from "./tunnelClient";
import { log } from "@/shared/lib/core/log";

export function useTunnelAutomations(): void {
  const tunnelRunning = useAppStore((s) => s.tunnelRunning);
  const automations = useAppStore((s) => s.automations);

  // Outbound projection — re-push whenever the list changes (no-op until a phone is paired).
  useEffect(() => {
    if (!tunnelRunning) return;
    tunnelSetAutomations(automations.map(automationToFrame))
      .catch((e) => log.error(`tunnel: set_automations failed: ${e}`));
  }, [tunnelRunning, automations]);

  // Inbound control — arm/disarm + run-now from the phone.
  useEffect(() => {
    let cancelled = false;

    const onArm = async (id: string, armed: boolean): Promise<void> => {
      const s = useAppStore.getState();
      const decision = planArm(s.automations.find((a) => a.id === id), id, armed);
      if (!decision.ok) {
        log.warn(`tunnel: rejecting mobile arm of "${id}" — ${decision.error}`);
        // Workspace the rejection back to the phone (also FCM-pushed, A4).
        await tunnelAutomationFailed(decision.id, Date.now(), decision.error, decision.name).catch(() => {});
        return;
      }
      log.info(`tunnel: mobile ${decision.armed ? "armed" : "disarmed"} automation "${decision.id}"`);
      s.setAutomationArmed(decision.id, decision.armed);
    };

    const onRunNow = async (id: string): Promise<void> => {
      const s = useAppStore.getState();
      const a = s.automations.find((x) => x.id === id);
      if (!a) {
        log.warn(`tunnel: run-now for unknown automation "${id}"`);
        return;
      }
      log.info(`tunnel: mobile run-now of automation "${id}"`);
      await dispatchAutomation(a, {
        tabs: s.tabs,
        disabledPanes: s.disabledPanes,
        write: (paneId, data) => invoke<void>("pty_write", { paneId, data }),
        recordRun: s.recordAutomationRun,
        now: () => Date.now(),
      });
    };

    const subs = [
      listen<{ id: string; armed: boolean }>("tunnel://automation-arm", (e) => {
        if (!cancelled) void onArm(e.payload.id, e.payload.armed);
      }),
      listen<{ id: string }>("tunnel://automation-run-now", (e) => {
        if (!cancelled) void onRunNow(e.payload.id);
      }),
    ];
    return () => {
      cancelled = true;
      for (const s of subs) void s.then((off) => off());
    };
  }, []);
}
