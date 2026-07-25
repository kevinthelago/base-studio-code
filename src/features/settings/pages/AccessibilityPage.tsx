import { Stack } from "@/shared/ui/layout/Stack";
import { SettingsPageHeader } from "./SettingsPageHeader";
import { TtsCard } from "../cards/TtsCard";

/** Settings → Accessibility (a11y epic #2725). Screen-reader / keyboard support is baked into the app;
 *  this page holds the app-owned text-to-speech that speaks the fleet coordination stream (Tier 1). */
export function AccessibilityPage() {
  return (
    <Stack gap={18} style={{ maxWidth: 820 }}>
      <SettingsPageHeader
        title="Accessibility"
        description="The app ships a keyboard + screen-reader baseline. On top of that, it can speak the fleet coordination stream aloud so you can drive the agents by ear."
      />
      <TtsCard />
    </Stack>
  );
}
