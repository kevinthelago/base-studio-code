import { WorkspaceCard } from "../cards/WorkspaceCard";
import { StorageCard } from "../cards/StorageCard";
import { DefaultModelCard } from "../cards/DefaultModelCard";
import { SessionsBehaviorCard } from "../cards/SessionsBehaviorCard";
import { TerminalFontSizeCard } from "../cards/TerminalFontSizeCard";
import { AccentColorCard } from "../cards/AccentColorCard";
import { ThemeCard } from "../cards/ThemeCard";
import { KeyboardCard } from "../cards/KeyboardCard";
import { AchievementsCard } from "../cards/AchievementsCard";

export function GeneralScreen() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 820 }}>
      {/* General */}
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>General</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 4px", fontSize: 12 }}>
        App-wide preferences for workspaces, models, theme appearance, and keyboard hotkeys.
      </p>

      {/* General app settings cards */}
      <WorkspaceCard />
      <StorageCard />
      <DefaultModelCard />
      <SessionsBehaviorCard />

      {/* Appearance cards */}
      <TerminalFontSizeCard />
      <AccentColorCard />
      <ThemeCard />

      {/* Keyboard shortcuts */}
      <KeyboardCard />

      {/* Achievements */}
      <AchievementsCard />
    </div>
  );
}
