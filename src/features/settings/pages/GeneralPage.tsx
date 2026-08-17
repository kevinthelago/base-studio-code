import { WorkspaceCard } from "@/features/settings/cards/WorkspaceCard";
import { ConsolePageCard } from "@/features/settings/cards/ConsolePageCard";
import { DefaultModelCard } from "@/features/settings/cards/DefaultModelCard";
import { SessionsBehaviorCard } from "@/features/settings/cards/SessionsBehaviorCard";
import { TerminalFontSizeCard } from "@/features/settings/cards/TerminalFontSizeCard";
import { AccentColorCard } from "@/features/settings/cards/AccentColorCard";
import { ThemeCard } from "@/features/settings/cards/ThemeCard";
import { KitThemeCard } from "@/features/settings/cards/KitThemeCard";
import { SoundNotificationsCard } from "@/features/settings/cards/SoundNotificationsCard";
import { KeyboardCard } from "@/features/settings/cards/KeyboardCard";
import { AchievementsCard } from "@/features/settings/cards/AchievementsCard";
import { DiagnosticsCard } from "@/features/settings/cards/DiagnosticsCard";
import { SandboxDependencyCard } from "@/features/settings/cards/SandboxDependencyCard";
import { ConfigBundleCard } from "@/features/settings/cards/ConfigBundleCard";
import { DemoStateCard } from "@/features/settings/cards/DemoStateCard";
import { StudioCard } from "@/features/settings/cards/StudioCard";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { SettingsPageHeader, SettingsSubHeader as Sub } from "@/features/settings/pages/SettingsPageHeader";

export function GeneralPage() {
  return (
    <Stack gap={18} style={{ maxWidth: 820 }}>
      <SettingsPageHeader
        title="General"
        description="App-wide preferences, required dependencies, appearance, and keyboard hotkeys."
      />

      <WorkspaceCard />
      <ConsolePageCard />
      <DefaultModelCard />
      <SessionsBehaviorCard />

      <Sub>Configuration</Sub>
      <ConfigBundleCard />
      <StudioCard />
      <DemoStateCard />

      <Sub>Required dependencies</Sub>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 -4px", fontSize: 12, lineHeight: 1.55 }}>
        The host tools the app and its agents rely on. <b>Nothing here is installed automatically</b> —
        each shows its status and how to install it, and you choose. The <Text as="span" mono>claude</Text>{" "}
        row is for the default Claude Code runtime; the bundled <Text as="span" mono>bsc-agent</Text> needs no CLI.
      </p>
      <DiagnosticsCard />
      <SandboxDependencyCard />

      <Sub>Appearance</Sub>
      <TerminalFontSizeCard />
      <AccentColorCard />
      <ThemeCard />
      <KitThemeCard />
      <SoundNotificationsCard />

      <Sub>Keyboard</Sub>
      <KeyboardCard />

      <Sub>Achievements</Sub>
      <AchievementsCard />
    </Stack>
  );
}
