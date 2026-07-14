// AnimationsMenu (#2942 · #3067 · #3069) — the right-pane MOTION navigator for the Design Studio's
// animation try-on, the sibling of ThemesMenu. In preview mode the right pane toggles Themes | Animations.
// Motion is PER-COMPONENT (#3065/#3067): the menu leads with the SELECTED COMPONENT's OWN animations — the
// motion that plays on it (`ComponentRecord.animations`, resolved to `AnimationDef[]`) — and keeps the
// kit's `animations` library below as a thin, secondary "generic shelf" of reusable motion (rendered only
// when the kit has any). Clicking an ungrouped or a shelf row PLAYS it on the center vehicle (`onPlay` →
// the studio applies `.<kit>-anim-<name>` to the preview #root); clicking the active one again clears. In
// the shelf, the animations the component references BY NAME are marked with a ● dot.
// VARIATION SLOTS (#3069): the component's OWN motion is partitioned by `group` — animations sharing a
// group are alternatives of ONE slot ("bars entering"), rendered under a slot sub-header with a ★ on the
// slot DEFAULT (the one that plays; distinct from the shelf's ● reference dot). Clicking a variation row
// SELECTS it as the slot default (`onSelectVariation` → the studio rewrites the component + persists), the
// motion analog of a component variant.
// Reuses the shared rail scaffold (GraphRail · RailGroupHeader · RailRow) so it reads exactly like
// ThemesMenu, mirrored into the right pane.
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { RailGroupHeader } from "@/shared/ui/layouts/RailGroupHeader";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { KitAnimation } from "@/shared/ui/kit";

/** When each motion plays → a compact glyph in the row's leading slot. */
const TRIGGER_GLYPH: Record<string, string> = { mount: "▸", hover: "☝", always: "∞" };

/** One motion row — the try-on cell shared by the ungrouped + shelf groups. Clicking plays it on the
 *  vehicle (or clears when it's already the active try-on); `bound` shows the ● reference dot (shelf). */
function AnimRow({ a, bound, activeName, onPlay }: {
  a: KitAnimation;
  bound: boolean;
  activeName: string | null;
  onPlay: (name: string | null) => void;
}) {
  const trigger = a.trigger ?? "mount";
  return (
    <RailRow
      active={a.name === activeName}
      onClick={() => onPlay(a.name === activeName ? null : a.name)}
      leading={
        <Text as="span" mono size="xs" tone="dim" title={`plays on ${trigger}`}>
          {TRIGGER_GLYPH[trigger] ?? "▸"}
        </Text>
      }
      trailing={
        <Text as="span" mono size="xxs" tone="dim">
          {bound ? "● " : ""}{trigger}
        </Text>
      }
      title={`${a.name} — plays on ${trigger}${bound ? " · referenced by this component" : ""}`}
      data-anim-name={a.name}
    >
      {a.name}
    </RailRow>
  );
}

/** One VARIATION row within a slot group (#3069) — an alternative motion for the slot. Clicking SELECTS
 *  it as the slot's DEFAULT (the motion analog of picking a variant), which is the primary action here;
 *  the current default carries a ★ and reads as `active`. Shares AnimRow's leading trigger glyph. */
function VariationRow({ a, group, isDefault, onSelectVariation }: {
  a: KitAnimation;
  group: string;
  isDefault: boolean;
  onSelectVariation?: (group: string, name: string) => void;
}) {
  const trigger = a.trigger ?? "mount";
  return (
    <RailRow
      active={isDefault}
      onClick={() => onSelectVariation?.(group, a.name)}
      leading={
        <Text as="span" mono size="xs" tone="dim" title={`plays on ${trigger}`}>
          {TRIGGER_GLYPH[trigger] ?? "▸"}
        </Text>
      }
      trailing={
        <Text as="span" mono size="xxs" tone={isDefault ? "accent" : "dim"}>
          {isDefault ? "★ " : ""}{trigger}
        </Text>
      }
      title={`${a.name} — ${isDefault ? "the slot default (plays)" : "click to make this the slot default"} · plays on ${trigger}`}
      data-anim-name={a.name}
    >
      {a.name}
    </RailRow>
  );
}

/** The right-pane animations menu (#3067/#3069). Two groups: the SELECTED COMPONENT's own motion (the
 *  star — what actually plays), then the kit's reusable "generic shelf" below (only when it has any).
 *  Within "This component", animations sharing a `group` are VARIATIONS of one SLOT (#3069): rendered
 *  under a slot sub-header, the DEFAULT marked ★; clicking one makes it the slot default
 *  (`onSelectVariation`). Ungrouped + shelf rows play on the vehicle (the try-on); `activeName`
 *  highlights the active one. */
export function AnimationsMenu({ componentAnimations, shelf, boundShelfNames, activeName, onPlay, onSelectVariation }: {
  /** The selected component's OWN resolved animations — the FULL set (all variations, each carrying its
   *  `group`/`default`), so the menu can present + switch each slot's variations. */
  componentAnimations: KitAnimation[];
  /** The kit's animation library — the reusable/generic shelf, shown as a secondary group. */
  shelf: KitAnimation[];
  /** Names of SHELF animations the component references — marked with a ● dot in the shelf group. */
  boundShelfNames: string[];
  /** The animation currently played on the vehicle (the try-on), or null. */
  activeName: string | null;
  /** Play a motion on the vehicle; the active name again (or null) clears it. */
  onPlay: (name: string | null) => void;
  /** Select a VARIATION as its slot's default (#3069) — `(group, name)`. Omitted ⇒ variation rows are
   *  inert (the menu still renders the slots + ★). */
  onSelectVariation?: (group: string, name: string) => void;
}) {
  const bound = new Set(boundShelfNames);
  // Partition the component's OWN motion into ungrouped rows + VARIATION SLOTS (#3069), preserving
  // first-appearance order for both the ungrouped list and the slots (mirrors resolveComponentAnimations).
  const ungrouped = componentAnimations.filter((a) => !a.group);
  const slots: { group: string; variations: KitAnimation[] }[] = [];
  const slotIndex = new Map<string, number>();
  for (const a of componentAnimations) {
    if (!a.group) continue;
    let i = slotIndex.get(a.group);
    if (i === undefined) { i = slots.length; slotIndex.set(a.group, i); slots.push({ group: a.group, variations: [] }); }
    slots[i].variations.push(a);
  }
  return (
    <GraphRail
      label="Animations"
      count={componentAnimations.length}
      // Mirror the left rail into the right pane, exactly like ThemesMenu.
      style={{ borderRight: "none", borderLeft: "1px solid var(--border)" }}
    >
      {/* Primary — this component's OWN motion (the star: what actually plays on it). */}
      <RailGroupHeader count={componentAnimations.length} title="motion this component actually plays">
        This component
      </RailGroupHeader>
      {componentAnimations.length === 0 ? (
        <Box style={{ padding: "4px 10px 10px" }}>
          <Text size="xs" tone="dim">No animations on this component yet.</Text>
        </Box>
      ) : (
        <>
          {/* Ungrouped motion — each plays; one row apiece, exactly as before. */}
          {ungrouped.map((a, i) => (
            <AnimRow key={`own:${a.name}:${i}`} a={a} bound={false} activeName={activeName} onPlay={onPlay} />
          ))}
          {/* Variation slots — alternatives of one slot under its header; ★ marks the default that plays. */}
          {slots.map(({ group, variations }) => {
            const def = variations.find((v) => v.default) ?? variations[0];
            return (
              <Box key={`slot:${group}`}>
                <RailGroupHeader count={variations.length} title="variation slot — one of these plays; ★ is the default">
                  {group}
                </RailGroupHeader>
                {variations.map((a, i) => (
                  <VariationRow
                    key={`var:${group}:${a.name}:${i}`}
                    a={a}
                    group={group}
                    isDefault={a.name === def.name}
                    onSelectVariation={onSelectVariation}
                  />
                ))}
              </Box>
            );
          })}
        </>
      )}

      {/* Secondary — the kit's reusable/generic shelf (only when it carries any). */}
      {shelf.length > 0 && (
        <>
          <RailGroupHeader
            count={shelf.length}
            title="reusable motion the kit owns — attachable to any of its components"
          >
            Generic shelf
          </RailGroupHeader>
          {shelf.map((a) => (
            <AnimRow key={`shelf:${a.name}`} a={a} bound={bound.has(a.name)} activeName={activeName} onPlay={onPlay} />
          ))}
        </>
      )}
    </GraphRail>
  );
}
