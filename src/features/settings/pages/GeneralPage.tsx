import { WorkspaceCard } from "../cards/WorkspaceCard";
import { DefaultModelCard } from "../cards/DefaultModelCard";
import { SessionsBehaviorCard } from "../cards/SessionsBehaviorCard";
import { TerminalFontSizeCard } from "../cards/TerminalFontSizeCard";
import { AccentColorCard } from "../cards/AccentColorCard";
import { ThemeCard } from "../cards/ThemeCard";
import { KeyboardCard } from "../cards/KeyboardCard";
import { AchievementsCard } from "../cards/AchievementsCard";
import { DiagnosticsCard } from "../cards/DiagnosticsCard";
import { SandboxDependencyCard } from "../cards/SandboxDependencyCard";
import { ConfigBundleCard } from "../cards/ConfigBundleCard";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";

/** A settings page sub-section header — the group label within a page (scaled-down page h2). */
function Sub({ children }: { children: string }) {
  return (
    <h3 className="mono" style={{ fontSize: 12.5, margin: "10px 0 -6px", fontWeight: 600, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".07em" }}>
      {children}
    </h3>
  );
}

export function GeneralPage() {
  return (
    <Stack gap={18} style={{ maxWidth: 820 }}>
      <h2 className="mono" style={{ fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>General</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 4px", fontSize: 12 }}>
        App-wide preferences, required dependencies, appearance, and keyboard hotkeys.
      </p>

      <WorkspaceCard />
      <DefaultModelCard />
      <SessionsBehaviorCard />

      <Sub>Configuration</Sub>
      <ConfigBundleCard />

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

      <Sub>Keyboard</Sub>
      <KeyboardCard />

      <Sub>Achievements</Sub>
      <AchievementsCard />
    </Stack>
  );
}
