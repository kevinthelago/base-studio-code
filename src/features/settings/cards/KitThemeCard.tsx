// KitThemeCard (#1852 Phase 3) — the kit-theme picker + a live spec×theme preview. Picking a theme
// sets it globally (store `kitTheme` → applied to :root in useAppBoot), retinting every card/button/
// field/chip across the app. The preview renders the SDK's demo spec (`@/shared/ui/spec`) under a
// <ThemeScope> so you see the SPEC axis and the THEME axis compose — the epic's payoff, live.
// The choices are the HYDRATED theme collection (#2488, store `kitThemes` — designer-authored themes
// included; packaged registry until the theme store hydrates).

import { Card } from "@/shared/ui/data/Card";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { ThemeScope } from "@/shared/ui/kit";
import { KitRenderer, demoSpec } from "@/shared/ui/spec";
import { useAppStore } from "@/store";

export function KitThemeCard() {
  const kitTheme = useAppStore((s) => s.kitTheme);
  const setKitTheme = useAppStore((s) => s.setKitTheme);
  const kitThemes = useAppStore((s) => s.kitThemes);
  const active = kitThemes.find((t) => t.id === kitTheme) ?? kitThemes[0];

  return (
    <Card title="Kit theme" hint="restyles every card, button, field & chip">
      <Stack gap="md">
        <Row gap="sm" wrap>
          {kitThemes.map((t) => (
            <Button
              key={t.id}
              variant={t.id === kitTheme ? "primary" : "default"}
              title={t.description}
              onClick={() => setKitTheme(t.id)}
            >
              {t.label}
            </Button>
          ))}
        </Row>
        <Text tone="dim" size="sm">{active.description}</Text>

        {/* Live preview: the SDK demo spec, rendered under the selected theme (scoped). */}
        <Box>
          <Text tone="muted" size="xs" mono style={{ textTransform: "uppercase", letterSpacing: ".06em" }}>
            Preview
          </Text>
          <Box style={{ marginTop: 6, maxWidth: 340 }}>
            <ThemeScope theme={kitTheme}>
              <KitRenderer node={demoSpec} values={{ provider: "anthropic", stream: true }} />
            </ThemeScope>
          </Box>
        </Box>
      </Stack>
    </Card>
  );
}
