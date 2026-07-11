// PaletteStrip (#2834) — the selected theme's semantic palette shown as labeled swatches at the top of
// the theme try-on center, alongside the big preview: you see the applied result AND the raw palette
// together. Each swatch is the theme's override (a literal colour) or the base default (`var(--token)`),
// grouped surfaces · text · borders · accent · status. Reads like a compact legend.
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { PALETTE_GROUPS, swatchColor } from "./lib/palette";
import type { KitThemeRecord } from "./lib/themes";

export function PaletteStrip({ theme }: { theme: KitThemeRecord }) {
  const vars = theme.vars ?? {};
  return (
    <Box
      className="ds-palette"
      style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start", flex: "none", padding: "10px 16px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)" }}
    >
      {PALETTE_GROUPS.map((g) => (
        <Box key={g.label} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <Eyebrow size={9}>{g.label}</Eyebrow>
          <Box style={{ display: "flex", gap: 6 }}>
            {g.tokens.map((t) => {
              const overridden = t.token in vars;
              return (
                <Box
                  key={t.token}
                  title={`${t.token}${overridden ? ` · ${vars[t.token]}` : " · base default"}`}
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}
                >
                  <ColorSwatch className="ds-swatch" color={swatchColor(vars, t.token)} size={24} radius={5} style={{ border: "1px solid var(--border)" }} />
                  <Text mono size={9} tone="dim">{t.name}</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
