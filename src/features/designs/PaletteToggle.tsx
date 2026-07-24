// PaletteToggle (#3706) — the theme try-on top-bar control. Shows the applied theme's label and
// toggles the PaletteStrip (the theme's raw swatch band), which is now HIDDEN by default so the
// specimen owns the full preview height. A pressed toggle (`aria-pressed`) — the caret + accent label
// read the open state — so the raw palette is opt-in rather than permanently costing a strip.
import { Button } from "@/shared/ui/controls/Button";
import { Text } from "@/shared/ui/typography/Text";

export function PaletteToggle({ label, open, onToggle }: {
  /** The applied theme's label (e.g. "Nord"). */
  label: string;
  /** Whether the palette strip is currently shown. */
  open: boolean;
  /** Flip the palette strip's visibility. */
  onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={open}
      onClick={onToggle}
      title={open ? "Hide the theme palette" : "Show the theme palette — the theme's raw semantic swatches"}
      style={open ? { background: "var(--bg-elev2)" } : undefined}
    >
      <Text as="span" size="xxs" tone="dim" aria-hidden="true">{open ? "▾" : "▸"}</Text>
      <Text as="span" mono size="xxs" tone={open ? "accent" : "muted"}>{label}</Text>
    </Button>
  );
}
