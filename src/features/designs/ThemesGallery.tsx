// Themes gallery (#themes-tab) — the Planner "Themes" page. Split out of the Designs studio so the
// THEME (style) axis has a first-class home, distinct from the kit/component (structure) axis (epic
// #2606 — kit=structure vs theme=style). A read-only browser of the designer-writable theme collection
// (`kitThemes`, seeded from @data/ui/themes.json, authored via `bsc ui theme`): each theme is a card
// carrying its identity + badges (default / built-in / surface), a LIVE sample (a Card + Buttons + Chips
// under <ThemeScope>) that shows the retint, and its semantic-token overrides. Like the studio treats
// the component library, this is a browser — themes are authored by the designer session, not edited here.
import { useMemo } from "react";
import { useAppStore } from "@/store";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";
import { Chip } from "@/shared/ui/data/Chip";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { ThemeScope, DEFAULT_THEME } from "@/shared/ui/kit";
import { orderThemes, type KitThemeRecord } from "./lib/themes";
import "./themesGallery.css";

export function ThemesGallery() {
  const kitThemes = useAppStore((s) => s.kitThemes);
  // The pickers' canonical order (packaged first, `default` leading; then authored, by label).
  const themes = useMemo(() => orderThemes(kitThemes), [kitThemes]);

  if (!themes.length) {
    return (
      <EmptyState
        icon="◈" iconVariant="dashed"
        title="No themes yet"
        description={<>A <b style={{ color: "var(--fg)" }}>theme</b> is a palette of semantic-token overrides — the <b style={{ color: "var(--fg)" }}>style</b> axis over your kits. Author one from the Designs studio's designer session (<Text as="code" mono>bsc ui theme</Text>).</>}
        style={{ height: "100%" }}
      />
    );
  }

  return (
    <Box className="themes-root">
      <Box className="themes-head">
        <Text className="themes-eyebrow" as="span">Themes</Text>
        <Text mono size="xxs" tone="dim">{themes.length} theme{themes.length === 1 ? "" : "s"}</Text>
        <Box style={{ flex: 1 }} />
        <Text size={11.5} tone="dim">Authored by the designer session · <Text as="code" mono size="xxs">bsc ui theme</Text></Text>
      </Box>
      <Box className="themes-scroll">
        <Box className="themes-grid">
          {themes.map((t) => (
            <ThemeCard key={t.id} theme={t} isDefault={t.id === DEFAULT_THEME} />
          ))}
        </Box>
      </Box>
    </Box>
  );
}

/** One theme: neutral chrome (identity + badges + overrides) around a LIVE, themed sample. The sample
 *  sits inside a <ThemeScope> so its `.card`/`.btn`/`.chip` follow the theme's overrides; the base
 *  surface (dark/light) is carried as a badge rather than simulated (the studio's `renderSpecimen`
 *  owns surface-accurate preview — this gallery shows the component retint faithfully on one surface). */
function ThemeCard({ theme, isDefault }: { theme: KitThemeRecord; isDefault: boolean }) {
  const overrides = Object.entries(theme.vars);
  const base = theme.base ?? "dark";
  return (
    <Box className="theme-card">
      <Box className="theme-cardhead">
        <Box style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Text weight={600} size={14} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{theme.label}</Text>
          {isDefault && <Chip color="var(--accent)">default</Chip>}
          {theme.builtin && <Chip>built-in</Chip>}
        </Box>
        <Chip title={`${base} surface`}>{base === "light" ? "◑ light" : "◐ dark"}</Chip>
      </Box>

      {/* live sample — the theme applied to real primitives */}
      <ThemeScope theme={theme.id} className="theme-preview">
        <Card className="theme-sample" title="Aa Sample">
          <Text size={12} tone="muted" as="div" style={{ marginBottom: 10 }}>A card, buttons, and chips under this theme.</Text>
          <Box style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <Button variant="primary" size="sm">Primary</Button>
            <Button size="sm">Default</Button>
            <Button variant="ghost" size="sm">Ghost</Button>
          </Box>
          <Box style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Chip color="var(--accent)">accent</Chip>
            <Chip>tag</Chip>
          </Box>
        </Card>
      </ThemeScope>

      {/* the theme's payload — its semantic-token overrides */}
      <Box className="theme-overrides">
        {overrides.length ? overrides.map(([k, v]) => (
          <Box key={k} className="theme-override">
            <Text mono size={10.5} tone="accent" style={{ whiteSpace: "nowrap" }}>{k}</Text>
            <Text mono size={10.5} tone="muted" style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "right" }}>{v}</Text>
          </Box>
        )) : <Text size={11.5} tone="dim" style={{ fontStyle: "italic" }}>Base look — no token overrides.</Text>}
      </Box>
    </Box>
  );
}
