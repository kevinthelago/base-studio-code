// useNavigateBridge (#3274, epic #3260) — apply a `bsc navigate` request to the store and ACK it.
//
// WHY THIS EXISTS
// `bsc shot` (#3261) gave bsc eyes; nothing gave it hands. The Design Studio's selection was local React
// state, so nothing outside the UI could select a component and an external session could only photograph
// whatever happened to be on screen. For the overnight loop (#3263) that is disqualifying: it needs
// "component X in theme Y", and without steering it would iterate on stale frames while every log line
// looked reasonable.
//
// THE ROUND TRIP
//   bsc navigate → request file → Rust watcher → `bsc://navigate` → HERE → store → `navigate_ack` → reply
//
// The ack is the point: it makes `bsc navigate … && bsc shot take` race-free rather than hoping the view
// landed first. So this ALWAYS acks — success or a stated error. Silence would strand the Rust waiter
// until its timeout and surface as "the frontend did not apply the navigation", sending someone to debug
// the wrong thing.
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { WORKSPACES, type Workspace } from "@/app/registry";
import { PROJECT_MODES } from "@/features/planner";
import { mountedPreviewFrames, type PreviewFrameEntry } from "@/features/designs";
import { log } from "@/shared/lib/core/log";
import { applyNavigate, type NavRequest, type NavAck } from "./navigateBridge";
import { installHumanPresence, humanPresent } from "@/app/humanPresence";

/** How long to wait for the preview frame to settle before acking. Well inside the Rust `ACK_TIMEOUT`
 *  (5s), with room left for the hydrate retry that can precede it — an ack that arrives late is a
 *  "the frontend did not apply the navigation" error, which sends the reader to debug the wrong thing. */
const MOUNT_BUDGET_MS = 1_800;
const MOUNT_POLL_MS = 40;

/** Wait for the preview frame showing `id` to SETTLE (built, or failed), or give up. Polls because the
 *  registry is deliberately React-free and module-level — it has no subscribe, and giving it one would
 *  make every frame's build path depend on a listener that only this bridge reads. A frame mid-rebuild is
 *  absent from the registry by construction, so "absent" here means "not settled yet", never "fine". */
async function settledFrame(id: string): Promise<PreviewFrameEntry | null> {
  const deadline = Date.now() + MOUNT_BUDGET_MS;
  for (;;) {
    const hit = mountedPreviewFrames().find((f) => f.component === id);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, MOUNT_POLL_MS));
  }
}

/**
 * Listen for `bsc://navigate` and apply it. Mounted once by the shell.
 *
 * Kept as a thin adapter: the DECISION (what a request resolves to, what errors) is pure and lives in
 * `navigateBridge.ts`, so it is unit-testable without Tauri or a rendered app.
 */
export function useNavigateBridge(): void {
  // #4248: the presence listeners live with the bridge that consults them, so a build cannot ship the
  // gate without the signal that feeds it (an always-absent human = the pre-#4248 behaviour, silently).
  useEffect(() => installHumanPresence(), []);

  useEffect(() => {
    let disposed = false;
    const un = listen<NavRequest & { id: string }>("bsc://navigate", (e) => {
      const { id, ...req } = e.payload;
      const resolve = (): NavAck =>
        applyNavigate(req, {
          // A LIVE getter, not `getState()` once: zustand hands out a new object per update, so a
          // captured snapshot would make the ack report the PRE-navigation view — a confident lie.
          read: () => useAppStore.getState(),
          workspaces: WORKSPACES.map((w) => w.key as Workspace),
          pages: PROJECT_MODES.map((p: { id: string }) => p.id),
          humanPresent,
        });

      void (async () => {
        let ack: NavAck;
        try {
          ack = resolve();
          // RE-READ ONCE ON A RESOLVABLE MISS (#navigate-answers-from-a-stale-app-snapshot).
          //
          // `applyNavigate` resolves against the app's HYDRATED copy of the component store, and that
          // copy only refreshes while the Design Studio is visible (`useUiActivity` is mounted there and
          // gated on it). A session that writes a component from a shell while the app shows Console
          // therefore gets "unknown component" for a record `bsc ui get` can print — request #55.
          //
          // A miss is the one moment the app has evidence its snapshot may be behind, so it is where the
          // re-read belongs. Bounded to a SINGLE retry by construction — there is no loop here — so a
          // genuinely unknown id still errors after one extra hydrate instead of spinning. Cheaper than
          // un-gating the activity watcher, which would poll in every workspace to serve a rare write.
          if (ack.retryAfterHydrate) {
            await useAppStore.getState().hydrateComponents();
            if (disposed) return;
            ack = resolve();
          }
        } catch (err) {
          // A throw here would silently strand the Rust waiter. Turn it into a stated error instead.
          ack = { id, error: `navigate threw: ${err instanceof Error ? err.message : String(err)}` };
          log.error(`navigate ${id} threw: ${String(err)}`);
        }
        // OBSERVE THE FRAME rather than trusting the selection. `landed()` reports the store value it
        // just wrote, so before this a component the preview REFUSED to build acked exactly like one
        // that rendered — and since the caller's next move is `bsc shot preview`, that produced a
        // capture of the previously-mounted component with nothing reporting it.
        if (ack.awaitMount) {
          const settled = await settledFrame(ack.awaitMount);
          if (disposed) return;
          if (!settled) {
            ack.mountError =
              `the preview had not settled on '${ack.awaitMount}' within ${MOUNT_BUDGET_MS}ms — do not ` +
              `capture yet; re-read with a bare \`bsc navigate\` before shooting`;
          } else if (settled.status === "error") {
            ack.mountError = `the preview refused to build '${ack.awaitMount}': ${settled.error ?? "no reason given"}`;
          } else {
            ack.mounted = settled.component;
          }
        }
        // `retryAfterHydrate` and `awaitMount` are OURS — strip them rather than shipping fields the
        // Rust `NavAck` never declared. (A field Rust does not declare is dropped SILENTLY, which is how
        // `declined` reached no caller for as long as it existed.)
        const { retryAfterHydrate: _retry, awaitMount: _await, ...wire } = ack;
        void invoke("navigate_ack", { ack: { ...wire, id } }).catch((e2) => {
          // Nothing left to do — the caller will time out. Log it so the cause isn't a mystery.
          log.error(`navigate_ack failed for ${id}: ${String(e2)}`);
        });
      })();
    });
    return () => {
      disposed = true;
      void un.then((f) => {
        if (disposed) f();
      });
    };
  }, []);
}
