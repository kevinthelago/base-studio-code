// useNotificationSounds (#3082, epic #3071 P4a) — the app dogfooding its own Sounds library. When the
// opt-in `soundNotifications` flag is ON (default OFF, Settings → Appearance), watch the coordination
// log and play a Signal-kit cue on each NEW completion/wait event since mount: landing/merge → success,
// failure → error, a worker pausing (`bsc-wait`) → notify. Mounted once app-wide (App.tsx).
//
// Baseline discipline: we never voice the backlog. On mount (and each time the flag is re-enabled) the
// first successful read just records the current line count; only lines appended AFTER that sound. A
// shrunk/replaced log re-baselines rather than replaying. While OFF the poll is a no-op (no I/O).
import { useRef } from "react";
import { useAppStore } from "@/store";
import { usePoll } from "@/shared/hooks/usePoll";
import { readCoordState } from "@/shared/lib/fleet/useCoordLog";
import { playCue } from "./lib/synth";
import { STARTER_KIT } from "./lib/soundKits";
import { cuesForLines } from "./lib/notifyCues";

/** Poll cadence for the coord-log watch (ms). Matches the coordinator's own 1 Hz read. */
const POLL_MS = 1000;

export function useNotificationSounds(): void {
  // Count of coord-log lines already accounted for; -1 = "not yet baselined" (re-baseline next read).
  const seen = useRef(-1);
  // Whether the flag was ON last tick — a false→true edge forces a re-baseline so enabling mid-session
  // starts from "now" instead of dumping the backlog.
  const wasOn = useRef(false);

  usePoll(async (isCancelled) => {
    const on = useAppStore.getState().soundNotifications;
    if (!on) { wasOn.current = false; return; }                     // OFF → no I/O
    if (!wasOn.current) { wasOn.current = true; seen.current = -1; } // just enabled → re-baseline

    const res = await readCoordState();
    if (isCancelled() || !res) return;                 // read failure → keep the baseline, retry next tick
    const n = res.lines.length;

    // First read after (re)baseline, or a shrunk/replaced log → set the baseline, voice nothing.
    if (seen.current < 0 || n < seen.current) { seen.current = n; return; }

    // De-dupe within the tick so a burst of e.g. merges doesn't stack identical cues over each other.
    const cues = [...new Set(cuesForLines(res.lines.slice(seen.current)))];
    seen.current = n;
    for (const id of cues) {
      const cue = STARTER_KIT.cues.find((c) => c.id === id);
      if (cue) playCue(cue, STARTER_KIT);
    }
  }, POLL_MS);
}
