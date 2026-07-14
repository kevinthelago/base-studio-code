// AnimationsMenu (#2942 · #3067) — the right-pane MOTION navigator for the Design Studio's animation
// try-on, the sibling of ThemesMenu. In preview mode the right pane toggles Themes | Animations. Motion
// is now PER-COMPONENT (#3065/#3067): the menu leads with the SELECTED COMPONENT's OWN animations — the
// motion that actually plays on it (`ComponentRecord.animations`, resolved to `AnimationDef[]`) — and
// keeps the kit's `animations` library below as a thin, secondary "generic shelf" of reusable motion
// (rendered only when the kit has any). Clicking a row in EITHER group PLAYS it on the center vehicle
// (`onPlay` → the studio applies `.<kit>-anim-<name>` to the preview #root); clicking the active one
// again clears. In the shelf, the animations the component references BY NAME are marked with a ● dot.
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

/** One motion row — the try-on cell shared by both groups. Clicking plays it on the vehicle (or clears
 *  when it's already the active try-on); `bound` shows the ● reference dot (used by the shelf group). */
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

/** The right-pane animations menu (#3067). Two groups: the SELECTED COMPONENT's own motion (the star —
 *  what actually plays), then the kit's reusable "generic shelf" below (only when it has any). Clicking a
 *  row in either group plays it on the vehicle (the try-on); `activeName` highlights the active one. */
export function AnimationsMenu({ componentAnimations, shelf, boundShelfNames, activeName, onPlay }: {
  /** The selected component's OWN resolved animations — the motion that actually plays on it. */
  componentAnimations: KitAnimation[];
  /** The kit's animation library — the reusable/generic shelf, shown as a secondary group. */
  shelf: KitAnimation[];
  /** Names of SHELF animations the component references — marked with a ● dot in the shelf group. */
  boundShelfNames: string[];
  /** The animation currently played on the vehicle (the try-on), or null. */
  activeName: string | null;
  /** Play a motion on the vehicle; the active name again (or null) clears it. */
  onPlay: (name: string | null) => void;
}) {
  const bound = new Set(boundShelfNames);
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
        componentAnimations.map((a, i) => (
          <AnimRow key={`own:${a.name}:${i}`} a={a} bound={false} activeName={activeName} onPlay={onPlay} />
        ))
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
