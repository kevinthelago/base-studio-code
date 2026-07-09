// Theme Studio PAGE (#2668) — the theme designer, one of the three Design-Studio pages. The user-facing
// surface for the #2606 per-kit design system: the component-theme collection (`bsc ui theme`) AND the
// domain palette (the `--graph-*` categorical tokens) — including the categories a downloaded blueprint
// CONTRIBUTED, tagged with their provenance. This first cut is a read/steer VIEW (per the UI-as-read-only
// goal, #2382 — the designer session edits, the user steers); apply/remove/generate + resolver
// diagnostics + the designer teaching follow in later slices.
import { useMemo, type ReactNode } from "react";
import { useAppStore } from "@/store";
import DESCRIPTOR from "@data/ui/style-descriptor.json";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Chip } from "@/shared/ui/data/Chip";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";

interface DomainToken { key: string; name: string; value: string; governs: string }
interface DomainGroup { group: string; governs: string; tokens: DomainToken[] }
interface DomainDescriptor { domain?: DomainGroup[] }

const looksLikeColor = (v: string) => /#|oklch|rgb|hsl|color-mix|var\(/i.test(v);

// The descriptor's domain token groups (graph-*) — a module constant (DESCRIPTOR is a static import), so
// it's a stable reference across renders and safe to read directly inside memos.
const DOMAIN_GROUPS: DomainGroup[] = (DESCRIPTOR as DomainDescriptor).domain ?? [];

/** One labelled colour chip — a swatch + its key. `sub` tags provenance (e.g. a contributing blueprint). */
function Swatch({ color, label, sub }: { color: string; label: string; sub?: string }) {
  return (
    <Box style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <Box style={{ width: 22, height: 22, flex: "none", borderRadius: 6, background: color, border: "1px solid var(--border)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.04)" }} />
      <Box style={{ minWidth: 0 }}>
        <Text mono size={11} as="div" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</Text>
        {sub && <Text size={9.5} tone="dim" as="div" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</Text>}
      </Box>
    </Box>
  );
}

function Section({ eyebrow, count, children }: { eyebrow: string; count?: number; children: ReactNode }) {
  return (
    <Box style={{ marginBottom: 26 }}>
      <Box style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Text className="ds-eyebrow" as="span">{eyebrow}</Text>
        {count != null && <Text mono size="xxs" tone="dim">{count}</Text>}
      </Box>
      {children}
    </Box>
  );
}

export function ThemeStudioPage() {
  const kitThemes = useAppStore((s) => s.kitThemes);
  const designContributions = useAppStore((s) => s.designContributions);

  // Contributed graph-category tokens keyed by full token name → { value, source } (last source wins,
  // matching compileContributionsCss). Provenance surfaces which blueprint added a category (#2606).
  const contribByToken = useMemo(() => {
    const m = new Map<string, { value: string; source: string }>();
    for (const o of designContributions) for (const [name, value] of Object.entries(o.tokens)) m.set(name, { value, source: o.source });
    return m;
  }, [designContributions]);

  const domain = DOMAIN_GROUPS;

  // The graph-category tokens the CONTRIBUTIONS add that the contract doesn't define (new categories a
  // downloaded blueprint introduced) — shown alongside the built-ins so the palette is complete.
  const contributedCategories = useMemo(() => {
    const known = new Set((DOMAIN_GROUPS.find((g) => g.group === "graph-category")?.tokens ?? []).map((t) => t.name));
    const out: { name: string; key: string; value: string; source: string }[] = [];
    for (const [name, { value, source }] of contribByToken) {
      if (name.startsWith("--graph-category-") && !known.has(name)) {
        out.push({ name, key: name.replace("--graph-category-", ""), value, source });
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }, [contribByToken]);

  return (
    <Box className="ds-page">
      <Box style={{ maxWidth: 920, margin: "0 auto" }}>
        <Box style={{ marginBottom: 22 }}>
          <Text as="h2" weight={600} size={18} style={{ margin: 0, letterSpacing: "-.01em" }}>Theme Studio</Text>
          <Text size={12} tone="muted" as="div" style={{ marginTop: 4, lineHeight: 1.5 }}>
            The design system's palette — component themes and the graph domain tokens. The designer session
            edits these via <Text as="span" mono size={11}>bsc ui</Text>; you steer.
          </Text>
        </Box>

        {/* ── component themes (bsc ui theme) ── */}
        <Section eyebrow="Themes · component palette" count={kitThemes.length}>
          {kitThemes.length === 0 ? (
            <Text size={12} tone="dim">No themes yet.</Text>
          ) : (
            <Box style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
              {kitThemes.map((t) => {
                const swatches = Object.entries(t.vars ?? {}).filter(([, v]) => looksLikeColor(v)).slice(0, 6);
                return (
                  <Box key={t.id} style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-soft)", padding: 12 }}>
                    <Box style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <Text weight={600} size={13} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.label}</Text>
                      <Chip>{t.base ?? "dark"}</Chip>
                      {t.builtin && <Chip color="var(--fg-dim)">built-in</Chip>}
                    </Box>
                    {swatches.length ? (
                      <Box style={{ display: "flex", gap: 5 }}>
                        {swatches.map(([name, v]) => (
                          <Box key={name} title={`${name}: ${v}`} style={{ width: 24, height: 24, borderRadius: 5, background: v, border: "1px solid var(--border)" }} />
                        ))}
                      </Box>
                    ) : (
                      <Text size={11} tone="dim" style={{ fontStyle: "italic" }}>stylesheet defaults (no overrides)</Text>
                    )}
                  </Box>
                );
              })}
            </Box>
          )}
        </Section>

        {/* ── domain palette (the graph-* categorical tokens) ── */}
        <Section eyebrow="Domain palette · graph tokens" count={domain.reduce((n, g) => n + g.tokens.length, 0)}>
          {domain.length === 0 ? (
            <Text size={12} tone="dim">The style descriptor defines no domain tokens.</Text>
          ) : (
            <Box style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {domain.map((g) => {
                const isCategory = g.group === "graph-category";
                return (
                  <Box key={g.group}>
                    <Text mono size={11} tone="muted" as="div" style={{ marginBottom: 8 }} title={g.governs}>{g.group}</Text>
                    <Box style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "9px 14px" }}>
                      {g.tokens.map((t) => {
                        const contributed = contribByToken.get(t.name);
                        return (
                          <Swatch
                            key={t.name}
                            color={contributed?.value ?? t.value}
                            label={t.key}
                            sub={contributed ? `overridden · ${contributed.source}` : undefined}
                          />
                        );
                      })}
                      {/* new categories a blueprint introduced (not in the contract) */}
                      {isCategory && contributedCategories.map((c) => (
                        <Swatch key={c.name} color={c.value} label={c.key} sub={`from ${c.source}`} />
                      ))}
                    </Box>
                  </Box>
                );
              })}
            </Box>
          )}
          {contributedCategories.length === 0 && (
            <Text size={11} tone="dim" as="div" style={{ marginTop: 14, fontStyle: "italic" }}>
              No blueprint has contributed extra categories yet — download one that introduces new design
              categories and its generated colours will appear here.
            </Text>
          )}
        </Section>

        {designContributions.length === 0 && domain.length === 0 && (
          <EmptyState icon="◈" iconVariant="dashed" title="No palette yet" description="The style descriptor defines the design tokens the studio renders." />
        )}
      </Box>
    </Box>
  );
}
