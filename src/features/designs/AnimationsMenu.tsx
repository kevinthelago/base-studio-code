// AnimationsMenu (#2942 · #3067 · #3069 · #3083) — the right-pane MOTION navigator for the Design
// Studio's animation try-on, the sibling of ThemesMenu. In preview mode the right pane toggles
// Themes | Animations.
//
// PRESETS (#3083): a component's motion is presented as a PICK-ONE list of PRESETS — each binding is a
// composed alternative ("slide in with grow + opacity" is ONE preset, not three rows), and exactly one
// is ACTIVE (plays). Clicking a preset SELECTS it as the component's motion (`onSelectPreset` → the
// studio folds every binding into one motion group with the pick as default, persists, and the preview
// replays it). This replaced the earlier flat "every animation on the component" list + per-slot
// variation sub-headers: the user picks a value, not a menu of atomic effects.
//
// Below the presets sits the kit's reusable "generic shelf" (only when the kit has any) — motion the kit
// owns, PLAYED on the center vehicle as a try-on (`onPlay` → the studio applies `.<kit>-anim-<name>` to
// the preview #root); clicking the active try-on again clears. The animations the component references BY
// NAME are marked with a ● dot there. Reuses the shared rail scaffold (GraphRail · RailGroupHeader ·
// RailRow) so it reads exactly like ThemesMenu, mirrored into the right pane.
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { RailGroupHeader } from "@/shared/ui/layouts/RailGroupHeader";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { KitAnimation } from "@/shared/ui/kit";

/** When each motion plays → a compact glyph in the row's leading slot. */
const TRIGGER_GLYPH: Record<string, string> = { mount: "▸", hover: "☝", always: "∞" };

/** One PRESET row (#3083) — a composed alternative for the component's motion. Clicking SELECTS it as the
 *  component's animation (the primary action); the ACTIVE preset (the one that plays) reads as `active`
 *  and carries an "active" trailing tag. */
function PresetRow({ a, active, onSelect }: {
  a: KitAnimation;
  active: boolean;
  onSelect?: (name: string) => void;
}) {
  const trigger = a.trigger ?? "mount";
  return (
    <RailRow
      active={active}
      onClick={() => onSelect?.(a.name)}
      leading={
        <Text as="span" mono size="xs" tone="dim" title={`plays on ${trigger}`}>
          {TRIGGER_GLYPH[trigger] ?? "▸"}
        </Text>
      }
      trailing={
        <Text as="span" mono size="xxs" tone={active ? "accent" : "dim"}>
          {active ? "active · " : ""}{trigger}
        </Text>
      }
      title={`${a.name} — ${active ? "the active preset (plays on this component)" : "click to make this the component's motion"} · plays on ${trigger}`}
      data-anim-name={a.name}
    >
      {a.name}
    </RailRow>
  );
}

/** One SHELF row — the kit's reusable motion, PLAYED on the vehicle as a try-on (or cleared when it's
 *  already the active try-on); `bound` shows the ● reference dot (the component references it by name). */
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

/** The right-pane animations menu (#3083). PRIMARY: the component's motion as a PICK-ONE list of
 *  PRESETS — the active one (the one that plays) is marked; clicking one makes it the component's motion
 *  (`onSelectPreset`). SECONDARY: the kit's reusable "generic shelf" (only when it has any), PLAYED on the
 *  vehicle as a try-on (`onPlay`; `activeName` highlights the active try-on). */
export function AnimationsMenu({ componentAnimations, shelf, boundShelfNames, activeName, onPlay, onSelectPreset }: {
  /** The selected component's OWN resolved animations — every binding, presented as the preset list. */
  componentAnimations: KitAnimation[];
  /** The kit's animation library — the reusable/generic shelf, shown as a secondary group. */
  shelf: KitAnimation[];
  /** Names of SHELF animations the component references — marked with a ● dot in the shelf group. */
  boundShelfNames: string[];
  /** The animation currently played on the vehicle (the shelf try-on), or null. */
  activeName: string | null;
  /** Play a SHELF motion on the vehicle; the active name again (or null) clears it. */
  onPlay: (name: string | null) => void;
  /** Select a PRESET as the component's motion (#3083) — the primary action. Omitted ⇒ preset rows are
   *  inert (the menu still renders the list + the active marker). */
  onSelectPreset?: (name: string) => void;
}) {
  const bound = new Set(boundShelfNames);
  // The ACTIVE preset — the one that plays (the component's current motion): the def marked `default`,
  // else the first in appearance order. Mirrors resolveComponentAnimations' one-per-group pick.
  const activePreset = componentAnimations.find((a) => a.default)?.name ?? componentAnimations[0]?.name ?? null;
  return (
    <GraphRail
      label="Animations"
      count={componentAnimations.length}
      // Mirror the left rail into the right pane, exactly like ThemesMenu.
      style={{ borderRight: "none", borderLeft: "1px solid var(--border)" }}
    >
      {/* Primary — the component's motion as a pick-one list of composed PRESETS. */}
      <RailGroupHeader count={componentAnimations.length} title="pick one — it becomes this component's motion">
        Presets
      </RailGroupHeader>
      {componentAnimations.length === 0 ? (
        <Box style={{ padding: "4px 10px 10px" }}>
          <Text size="xs" tone="dim">No animations on this component yet.</Text>
        </Box>
      ) : (
        componentAnimations.map((a, i) => (
          <PresetRow key={`preset:${a.name}:${i}`} a={a} active={a.name === activePreset} onSelect={onSelectPreset} />
        ))
      )}

      {/* Secondary — the kit's reusable/generic shelf (only when it carries any), a try-on. */}
      {shelf.length > 0 && (
        <>
          <RailGroupHeader
            count={shelf.length}
            title="reusable motion the kit owns — click to preview it on the component"
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
