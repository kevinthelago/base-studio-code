import { WorkspaceCard } from "../cards/WorkspaceCard";
import { DefaultModelCard } from "../cards/DefaultModelCard";
import { SessionsBehaviorCard } from "../cards/SessionsBehaviorCard";
import { TerminalFontSizeCard } from "../cards/TerminalFontSizeCard";
import { AccentColorCard } from "../cards/AccentColorCard";
import { ThemeCard } from "../cards/ThemeCard";
import { KitThemeCard } from "../cards/KitThemeCard";
import { KeyboardCard } from "../cards/KeyboardCard";
import { AchievementsCard } from "../cards/AchievementsCard";
import { DiagnosticsCard } from "../cards/DiagnosticsCard";
import { SandboxDependencyCard } from "../cards/SandboxDependencyCard";
import { ConfigBundleCard } from "../cards/ConfigBundleCard";
import { DemoStateCard } from "../cards/DemoStateCard";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { SettingsPageHeader, SettingsSubHeader as Sub } from "./SettingsPageHeader";

export function GeneralPage() {
  return (
    <Stack gap={18} style={{ maxWidth: 820 }}>
      <SettingsPageHeader
        title="General"
        description="App-wide preferences, required dependencies, appearance, and keyboard hotkeys."
      />

      <WorkspaceCard />
      <DefaultModelCard />
      <SessionsBehaviorCard />

      <Sub>Configuration</Sub>
      <ConfigBundleCard />
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

      <Sub>Keyboard</Sub>
      <KeyboardCard />

      <Sub>Achievements</Sub>
      <AchievementsCard />
    </Stack>
  );
}
