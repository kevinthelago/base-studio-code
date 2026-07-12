// AnimationsMenu (#2942) — the right-pane MOTION navigator for the Design Studio's animation try-on, the
// sibling of ThemesMenu. In preview mode the right pane toggles Themes | Animations; this lists the
// selected KIT's motion library (`Kit.animations`). Clicking a row PLAYS it on the center vehicle
// (`onPlay` → the studio applies `.<kit>-anim-<name>` to the preview #root); clicking the active one
// again clears. The animations the current component actually BINDS are marked. Reuses the shared rail
// scaffold (GraphRail · RailRow) so it reads exactly like ThemesMenu, mirrored into the right pane.
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { Text } from "@/shared/ui/typography/Text";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import type { KitAnimation } from "@/shared/ui/kit";

/** When each motion plays → a compact glyph in the row's leading slot. */
const TRIGGER_GLYPH: Record<string, string> = { mount: "▸", hover: "☝", always: "∞" };

/** The right-pane animations menu. Lists the selected kit's motion library; clicking a row plays it on
 *  the vehicle (the try-on). The names the current component binds are marked with a dot. */
export function AnimationsMenu({ animations, boundNames, activeName, onPlay }: {
  animations: KitAnimation[];
  /** The kit-animation names the vehicle component BINDS — marked in the list. */
  boundNames: string[];
  /** The animation currently played on the vehicle (the try-on), or null. */
  activeName: string | null;
  /** Play a motion on the vehicle; the active name again (or null) clears it. */
  onPlay: (name: string | null) => void;
}) {
  const bound = new Set(boundNames);
  return (
    <GraphRail
      label="Animations"
      count={animations.length}
      // Mirror the left rail into the right pane, exactly like ThemesMenu.
      style={{ borderRight: "none", borderLeft: "1px solid var(--border)" }}
    >
      {animations.length === 0 ? (
        <EmptyState
          icon="⟳"
          title="No motion in this kit"
          description="A kit's animations are authored by the designer via bsc ui."
        />
      ) : (
        animations.map((a) => {
          const trigger = a.trigger ?? "mount";
          const isBound = bound.has(a.name);
          return (
            <RailRow
              key={a.name}
              active={a.name === activeName}
              onClick={() => onPlay(a.name === activeName ? null : a.name)}
              leading={
                <Text as="span" mono size="xs" tone="dim" title={`plays on ${trigger}`}>
                  {TRIGGER_GLYPH[trigger] ?? "▸"}
                </Text>
              }
              trailing={
                <Text as="span" mono size="xxs" tone="dim">
                  {isBound ? "● " : ""}{trigger}
                </Text>
              }
              title={`${a.name} — plays on ${trigger}${isBound ? " · bound by this component" : ""}`}
              data-anim-name={a.name}
            >
              {a.name}
            </RailRow>
          );
        })
      )}
    </GraphRail>
  );
}
