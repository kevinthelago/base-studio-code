// Wire the tunnel's inbound coordination control into the desktop wake path (#935).
// src-tauri/src/tunnel.rs decodes a phone's wake/approve frames and re-emits them as
// Tauri events; without a listener they fell on the floor. This hook routes them through
// the SAME actuation the local Coordinator inbox uses, so a paired phone can wake a parked
// worker or approve a paused gate. Mount once at the app root (runs on any screen).

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store";
import { readCoordState } from "@/shared/lib/fleet/useCoordLog";
import { actuateWake, injectWake } from "@/shared/lib/fleet/coordinatorActuate";
import { planMobileResume, type CoordControlKind } from "./coordControl";
import { log } from "@/shared/lib/core/log";

export function useTunnelCoordControl(): void {
  useEffect(() => {
    let cancelled = false;

    const handle = async (kind: CoordControlKind, session: string): Promise<void> => {
      const res = await readCoordState(1000);
      if (cancelled || !res) return;
      const { state, ready } = res;
      const plan = planMobileResume(kind, session, state, ready);
      if (!plan) {
        // The phone named a session that isn't parked — ignore rather than wake blindly.
        log.warn(`tunnel: ignoring mobile ${kind} for "${session}" — not a parked session`);
        return;
      }
      log.info(`tunnel: mobile ${kind} → ${plan.via} resume of "${plan.session}"`);
      if (plan.via === "fresh") {
        await actuateWake(plan.session, plan.prompt, useAppStore.getState().wakePane);
      } else {
        await injectWake(plan.session, plan.prompt);
      }
    };

    const subs = [
      listen<{ session: string }>("tunnel://coord-wake", (e) => void handle("wake", e.payload.session)),
      listen<{ session: string }>("tunnel://coord-approve", (e) => void handle("approve", e.payload.session)),
    ];
    return () => {
      cancelled = true;
      for (const s of subs) void s.then((off) => off());
    };
  }, []);
}
