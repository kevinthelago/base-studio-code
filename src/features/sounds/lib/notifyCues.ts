// Opt-in notification-sound mapping (#3082, epic #3071 P4a) — the CONSUMER side of the Sounds pillar:
// map a fleet COORDINATION event to the Signal-kit cue that voices it. Pure (no Web Audio, no React) so
// the mapping + batch selection are unit-testable; the app-wide hook (useNotificationSounds) plays them.
import { parseCoordLine, type CoordEvent } from "@/shared/lib/fleet/coordination";

/** The three Signal-kit cues these notifications use (ids in `src-tauri/data/sounds/signal.json`). */
export type NotifyCue = "success" | "error" | "notify";

/**
 * Map one coordination event to the cue that should sound, or null if the event isn't voiced.
 * A landing/merge → `success`, a failure → `error`, a worker pausing for the user (`bsc-wait`) → `notify`.
 * (`closed`, `ask`, `assign`, … are intentionally silent — they aren't user-facing completions/pauses.)
 */
export function coordEventCue(ev: CoordEvent): NotifyCue | null {
  switch (ev.type) {
    case "landed":
    case "merged":
      return "success";
    case "failed":
      return "error";
    case "waiting":
      return "notify";
    default:
      return null;
  }
}

/**
 * Map a batch of NEW coord-log lines (oldest-first, the tail since the last poll) to the cues they
 * should sound, in order. Unparseable + non-voiced lines are dropped. Pure — the caller decides how to
 * play (and may de-duplicate to avoid stacking identical cues in one tick).
 */
export function cuesForLines(lines: string[]): NotifyCue[] {
  const cues: NotifyCue[] = [];
  for (const line of lines) {
    const ev = parseCoordLine(line);
    if (!ev) continue;
    const cue = coordEventCue(ev);
    if (cue) cues.push(cue);
  }
  return cues;
}
