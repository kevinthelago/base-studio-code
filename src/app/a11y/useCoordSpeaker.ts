// useCoordSpeaker (#3804, a11y epic #2725 Tier 1) — SPEAKS new coordination events aloud via the
// app-owned TTS engine (`speechSynthesis`), so a blind developer can drive the fleet BY EAR. The
// sibling of `useCoordAnnouncer` (#3770): both read the SAME seam — `useCoordLog()` → `coordAlerts`,
// whose `text` is already the human line ("api-stream paused and is waiting for you") — but the
// announcer writes to an ARIA live region for the user's OWN screen reader, while this one speaks with
// the app's voice. It speaks only the STRUCTURED events, never the raw terminal stream.
//
// Opt-in + fully off by default; settings (enabled/rate/voice/verbosity) are read FRESH per event from
// the store, so toggling on mid-session takes effect immediately WITHOUT replaying history. The mount
// backlog is seeded SILENT, and every alert id is remembered whether or not it was spoken — so enabling
// TTS never buries the user under the events that were already on screen.
import { useEffect, useRef } from "react";
import { useCoordLog } from "@/shared/lib/fleet/useCoordLog";
import { coordAlerts } from "@/features/tunnel";
import { useAppStore } from "@/store";
import { speak } from "@/shared/lib/a11y/speech";
import { shouldSpeak } from "./coordSpeech";

export function useCoordSpeaker(): void {
  const { state } = useCoordLog();
  const seen = useRef<Set<string>>(new Set());
  const seeded = useRef(false);

  useEffect(() => {
    const alerts = coordAlerts(state);
    const firstSeed = !seeded.current;
    seeded.current = true;
    for (const a of alerts) {
      if (seen.current.has(a.id)) continue;
      // Remember EVERY alert (even while off / on the initial backlog) so enabling never replays them.
      seen.current.add(a.id);
      if (firstSeed) continue;
      const st = useAppStore.getState();
      if (st.ttsEnabled && shouldSpeak(a.kind, st.ttsVerbosity)) {
        speak(a.text, { rate: st.ttsRate, voiceURI: st.ttsVoice || undefined });
      }
    }
  }, [state]);
}
