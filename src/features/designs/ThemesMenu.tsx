// ThemesMenu (#2834) — the right-pane theme navigator for the Design Studio's theme try-on. In preview
// mode the inspector is replaced by this menu: the themes grouped by their design group (#2749's `tech`,
// the same axis the left kits rail groups by), each row a live mini-swatch + label + surface glyph.
// Selecting a row drives the center preview's retint (`onSelect` → the studio's `kitTheme`). Reuses the
// shared rail scaffold (GraphRail · RailGroupHeader · RailRow) so it reads exactly like the components
// rail — just mirrored into the right pane (border flipped to the left edge).
import { useMemo, useState } from "react";
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { RailGroupHeader } from "@/shared/ui/layouts/RailGroupHeader";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { ThemeScope } from "@/shared/ui/kit";
import { groupThemes, type KitThemeRecord } from "./lib/themes";

/** A live 3-bar palette chip for a theme: surface · accent · text, read through a <ThemeScope> so it
 *  reflects the theme's own token overrides (an empty-`vars` base theme inherits the current tokens). */
function ThemeSwatch({ id }: { id: string }) {
  return (
    <ThemeScope theme={id} style={{ display: "inline-flex", gap: 2, padding: 0, borderRadius: 3 }}>
      <ColorSwatch color="var(--bg-panel)" size={9} />
      <ColorSwatch color="var(--accent)" size={9} />
      <ColorSwatch color="var(--fg)" size={9} />
    </ThemeScope>
  );
}

/** The right-pane themes menu. Grouped by design group (#2749); selecting a row retints the preview. */
export function ThemesMenu({ themes, activeId, onSelect }: {
  themes: KitThemeRecord[];
  /** The currently-applied theme id — its row shows the canonical `.on` selection wash. */
  activeId: string;
  /** Apply a theme (drives the center preview's `themeVars`/surface). */
  onSelect: (id: string) => void;
}) {
  const groups = useMemo(() => groupThemes(themes), [themes]);
  // Collapse state per design group (default OPEN, like the Designs rail's tech groups).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return (
    <GraphRail
      label="Themes"
      count={themes.length}
      // Mirror the left rail into the right pane: drop the default right border, add the left edge so it
      // reads as the inspector column (the components rail keeps its border on the right).
      style={{ borderRight: "none", borderLeft: "1px solid var(--border)" }}
    >
      {groups.map((g) => {
        const open = !collapsed[g.tech];
        return (
          <Box key={g.tech} data-tech={g.tech}>
            <RailGroupHeader
              className="tm-grouphead"
              collapsible
              open={open}
              onToggle={() => setCollapsed((c) => ({ ...c, [g.tech]: !c[g.tech] }))}
              count={g.themes.length}
              title={`design group: ${g.label}`}
            >
              {g.label}
            </RailGroupHeader>
            {open && g.themes.map((t) => (
              <RailRow
                key={t.id}
                active={t.id === activeId}
                onClick={() => onSelect(t.id)}
                leading={<ThemeSwatch id={t.id} />}
                trailing={
                  <Text as="span" mono size="xxs" tone="dim" title={`${t.base ?? "dark"} surface`}>
                    {(t.base ?? "dark") === "light" ? "◑" : "◐"}
                  </Text>
                }
                title={`${t.label} — ${t.base ?? "dark"} surface`}
                data-theme-id={t.id}
              >
                {t.label}
              </RailRow>
            ))}
          </Box>
        );
      })}
    </GraphRail>
  );
}
