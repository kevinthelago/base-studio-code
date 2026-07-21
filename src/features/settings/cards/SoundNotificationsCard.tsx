import { useAppStore } from "@/store";
import { ToggleRow } from "../pages/SettingsControls";
import { Card } from "@/shared/ui/data/Card";

/** Settings → Appearance toggle for the opt-in coord-event notification sounds (#3082). */
export function SoundNotificationsCard() {
  const { soundNotifications, setSoundNotifications } = useAppStore();
  return (
    <Card title="Notification sounds" hint="opt-in — off by default">
      <ToggleRow
        on={soundNotifications}
        onToggle={() => setSoundNotifications(!soundNotifications)}
        title="Play a sound on fleet events"
      >
        Plays a short cue from the built-in <b>Signal</b> sound kit on key coordination events — a
        landing or merge chimes <code>success</code>, a failure chimes <code>error</code>, and a worker
        pausing for you chimes <code>notify</code>. Nothing plays until you enable it.
      </ToggleRow>
    </Card>
  );
}
