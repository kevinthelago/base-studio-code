// Blueprint Author — 1 · PURPOSE. Identity, description, audience, catalog tags,
// and a live catalog-card preview.

import authorOptionsEmbedded from "@data/planner/blueprint-author-options.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";
import { Ic } from "@/features/planner/blueprints/blueprintIcons";
import { Chip } from "@/shared/ui/data/Chip";
import { hue, tint, stageKind } from "@/features/planner/blueprints/blueprintCatalog";
import { IconBox } from "@/shared/ui/data/IconBox";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { TextArea } from "@/shared/ui/controls/Field";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { Blueprint } from "@/features/planner/stages/blueprints";
import { gateCount, Lbl, type AuthorViewProps } from "./shared";

// Catalog-tag + accent-hue choices — from `@data/planner/blueprint-author-options.json` (#2419,
// beside blueprint-meta.json); the config-dir copy (#2047) overlays the embedded default.
const { tags: TAGS, hueChoices: HUE_CHOICES } =
  overlayFile("planner/blueprint-author-options.json", authorOptionsEmbedded);

export function PurposeView({ bp, onChange }: AuthorViewProps) {
  const set = (patch: Partial<Blueprint>) => onChange({ ...bp, ...patch });
  const tags = bp.tags ?? [];
  const toggleTag = (t: string) => set({ tags: tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t] });
  const h = bp.h ?? 195;
  const stages = bp.sections ?? [];

  return (
    <Stack gap={18}>
      <Box>
        <Lbl hint="name & accent">Identity</Lbl>
        <Row gap={11} align="start">
          <Stack gap={7} align="center">
            <Box as="span" className="ed-icon" bg={tint(h, 0.18)} radius={9} style={{ width: 44, height: 44, fontSize: 19, display: "flex", alignItems: "center", justifyContent: "center", color: hue(h), border: `1px solid ${tint(h, 0.4)}` }}>{bp.icon || (bp.name?.[0] ?? "B").toUpperCase()}</Box>
            <Row gap={4}>
              {HUE_CHOICES.map((c) => (
                <Box as="span" key={c} onClick={() => set({ h: c })} title="accent hue"
                  bg={hue(c)} radius={4} style={{ width: 13, height: 13, cursor: "pointer",
                    outline: h === c ? "2px solid var(--fg)" : "none", outlineOffset: 1 }} />
              ))}
            </Row>
          </Stack>
          <Stack gap={8} style={{ flex: 1 }}>
            {/* eslint-disable-next-line no-restricted-syntax -- inline identity input (no per-input label; TextField's .field wrapper would restructure the stack) */}
            <input className="input" value={bp.name} placeholder="Blueprint name" style={{ fontSize: 13 }}
              onChange={(e) => set({ name: e.target.value, icon: (e.target.value[0] || "B").toUpperCase() })} />
            {/* eslint-disable-next-line no-restricted-syntax -- inline identity input (no per-input label; TextField's .field wrapper would restructure the stack) */}
            <input className="input" value={bp.pitch ?? ""} placeholder="One-line pitch — shown in the catalog"
              onChange={(e) => set({ pitch: e.target.value })} />
          </Stack>
        </Row>
      </Box>

      <Box>
        <Lbl hint="what it's for & why">Description</Lbl>
        <TextArea value={bp.desc ?? ""} style={{ minHeight: 78 }}
          placeholder="Describe the kind of project this blueprint plans…"
          onChange={(v) => set({ desc: v })} />
      </Box>

      <Box>
        <Lbl>Audience</Lbl>
        {/* eslint-disable-next-line no-restricted-syntax -- paired with the bespoke <Lbl> (not a real <label>); TextField's plain-label .field stack wouldn't match */}
        <input className="input" value={bp.audience ?? ""} placeholder="Who plans with this"
          onChange={(e) => set({ audience: e.target.value })} />
      </Box>

      <Box>
        <Lbl hint="catalog tags · pick a few">Best for</Lbl>
        <Box className="dep-row">
          {TAGS.map((t) => (
            // eslint-disable-next-line no-restricted-syntax -- bespoke .dep-chip tag toggle (not .btn family)
            <button key={t} className={"dep-chip" + (tags.includes(t) ? " on" : "")} onClick={() => toggleTag(t)}>
              {t}{tags.includes(t) && <Text as="span" style={{ opacity: 0.7 }}> ✓</Text>}
            </button>
          ))}
        </Box>
      </Box>

      <Box>
        <Lbl hint="how it appears in the library">Catalog preview</Lbl>
        <Box className="bp-card" style={{ cursor: "default" }}>
          <Box className="bp-top">
            <IconBox size={34} radius={8} fontSize={15} background={tint(h, 0.16)} color={hue(h)} border={`1px solid ${tint(h, 0.4)}`}>{bp.icon || (bp.name?.[0] ?? "B").toUpperCase()}</IconBox>
            <Box style={{ minWidth: 0 }}>
              <h3>{bp.name || "Untitled blueprint"}</h3>
              <p className="bp-desc">{bp.pitch || "Add a one-line pitch…"}</p>
            </Box>
          </Box>
          <Box className="seq">
            {stages.slice(0, 6).map((s, i) => {
              const k = stageKind(s.key);
              return (
                <Box as="span" key={s.uid} style={{ display: "contents" }}>
                  {i > 0 && <Text as="span" className="arr">→</Text>}
                  <Box as="span" className={"st-g" + (gateCount(s) ? " gated" : "")} title={k.title}><Ic n={k.glyph} size={11} /></Box>
                </Box>
              );
            })}
            {stages.length > 6 && <Text as="span" className="more">+{stages.length - 6}</Text>}
          </Box>
          <Box className="bp-foot">
            <Text as="span">{stages.length} stage{stages.length === 1 ? "" : "s"}</Text>
            <Box as="span" className="sp" />
            {tags.slice(0, 3).map((t) => <Chip key={t}>{t}</Chip>)}
          </Box>
        </Box>
      </Box>
    </Stack>
  );
}
