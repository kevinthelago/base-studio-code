// Org designer — the small reusable pieces extracted from the Claude Design prototype (#2193), built on
// the shared UI kit (Chip/Box/Row/Text) so they read as one system with the rest of the app. Used by
// both the canvas node cards and the right-hand inspector.
import { Chip } from "@/shared/ui/data/Chip";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { SessionRole } from "@/shared/lib/session/sessionRoles";
import { tierChips, formColor, formArrow, type TierChip } from "./lib/orgView";
import type { CommunicationForm } from "./lib/org";

/** Color for a capability tier: write = amber (mutating), read = blue, net-on = accent, else muted. */
function tierColor(tier: string): string {
  if (tier === "write") return "oklch(0.78 0.12 70)";
  if (tier === "read") return "oklch(0.75 0.1 250)";
  if (tier === "on") return "var(--accent)";
  return "var(--fg-dim)";
}

/** The capability-tier row for a role (git·write · code·write · net·on …) — the permission floor a
 *  position inherits, rendered as mono pills. Reused on the canvas card + the inspector clearance block. */
export function TierChips({ role, size = 9.5 }: { role: SessionRole; size?: number }) {
  return (
    <Row gap={4} wrap>
      {tierChips(role).map((t: TierChip) => (
        <Chip key={t.label} color={tierColor(t.tier)} fontSize={size}>{t.label}</Chip>
      ))}
    </Row>
  );
}

/** A single communication-form chip — its direction glyph + name, colored by the form's semantics.
 *  Optionally trailed by its runtime note (delivery · authority / parks caller / …). */
export function FormChip({ form, note = false }: { form: CommunicationForm; note?: boolean }) {
  return (
    <Row gap={7} align="center">
      <Chip color={formColor(form)} style={{ fontWeight: 600, minWidth: 92 }}>
        {formArrow(form)} {form.label}
      </Chip>
      {note && <Text as="span" mono size={10} tone="dim">{form.blurb.split(";")[0]}</Text>}
    </Row>
  );
}

/** A labelled section header (uppercase mono micro-label + optional right slot) — the inspector's
 *  repeated block header. */
export function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <Row align="center" justify="between" style={{ marginBottom: 9 }}>
      <Text as="div" className="ulabel" tone="dim" size={9.5}>{children}</Text>
      {right}
    </Row>
  );
}

/** A form-flow lane (A → B header + the forms that direction), the inspector's relationship view unit. */
export function FormLane({ from, to, forms, hue }: { from: string; to: string; forms: CommunicationForm[]; hue: number }) {
  return (
    <Box style={{ border: "1px solid var(--border-soft)", borderRadius: 11, overflow: "hidden", background: "var(--bg-soft)" }}>
      <Row gap={7} align="center" style={{ padding: "9px 12px", background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)" }}>
        <Text as="span" weight={600} size={11.5}>{from}</Text>
        <Text as="span" weight={700} style={{ color: `oklch(0.72 0.13 ${hue})` }}>→</Text>
        <Text as="span" weight={600} size={11.5}>{to}</Text>
      </Row>
      <Box style={{ padding: "11px 12px" }}>
        {forms.length === 0
          ? <Text as="div" size={11} tone="dim" style={{ fontStyle: "italic" }}>no forms this direction</Text>
          : <Stack gap={7}>{forms.map((f) => <FormChip key={f.id} form={f} note />)}</Stack>}
      </Box>
    </Box>
  );
}
