// The plan-injection provenance banner (#1107). Surfaces the markers the deterministic scan flagged
// in the planner's authored sections, at the planning pane's top, so the user reviews them before
// the plan seeds the fleet. Acknowledge-to-clear by default; the hard-gate setting turns the ack off
// and demands the flagged content be removed.

import { type InjectionGate, injectionSignature } from "../lib/planInjection";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

const MONO = "var(--mono)";
const CAT_LABEL: Record<string, string> = {
  override: "instruction override", exfiltration: "exfiltration",
  perms: "permission bypass", destructive: "destructive git/gh", ci: "CI / hook tampering",
};

export function InjectionGateBanner({ gate, onAcknowledge }: {
  gate: InjectionGate;
  onAcknowledge: (signature: string) => void;
}) {
  if (gate.findings.length === 0) return null;
  const blocked = gate.mode === "blocked";
  const cleared = gate.cleared;
  const color = blocked ? "var(--danger)" : cleared ? "var(--success)" : "var(--accent)";
  const n = gate.findings.length;

  return (
    <Box data-testid="injection-banner" bg={`color-mix(in oklch, ${color}, transparent 90%)`} radius="md" style={{
      flex: "0 0 auto", margin: "10px 12px 0", overflow: "hidden",
      border: `1px solid color-mix(in oklch, ${color}, transparent 60%)`,
    }}>
      <Row gap={8} style={{ padding: "8px 11px" }}>
        <Text as="span" size={13} style={{ color }}>{blocked ? "⛔" : cleared ? "✓" : "⚠"}</Text>
        <Text as="span" size={11} weight={600} style={{ fontFamily: MONO, color }}>
          {n} possible prompt-injection marker{n !== 1 ? "s" : ""} in the plan
        </Text>
        <Box as="span" style={{ flex: 1 }} />
        <Text as="span" size={9} tone="dim" style={{ fontFamily: MONO }}>
          {blocked ? "hard-block" : cleared ? "reviewed" : "review to publish"}
        </Text>
      </Row>

      <Stack gap={4} style={{ padding: "0 11px 9px", maxHeight: 160, overflowY: "auto" }}>
        {gate.findings.map((f, i) => (
          <Text as="div" key={`${f.file}-${f.line}-${i}`} size={9.5} tone="muted" style={{ fontFamily: MONO, lineHeight: 1.45 }}>
            <Text as="span" style={{ color: "var(--info)" }}>{f.file}:{f.line}</Text>
            {" · "}<Text as="span" style={{ color }}>{CAT_LABEL[f.category] ?? f.category}</Text>
            <Text as="div" tone="dim" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.context}</Text>
          </Text>
        ))}
      </Stack>

      <Row gap={8} style={{ padding: "8px 11px", borderTop: `1px solid color-mix(in oklch, ${color}, transparent 70%)` }}>
        <Text as="span" size={9} tone="dim" style={{ fontFamily: MONO, flex: 1, lineHeight: 1.5 }}>
          {blocked
            ? "These read like instructions injected from reviewed content. Remove them from the plan to publish (hard-block is on in Settings)."
            : "Confirm none of these is an instruction smuggled in from a reviewed repo or page before it seeds the fleet."}
        </Text>
        {!blocked && !cleared && (
          <button
            data-testid="injection-ack"
            onClick={() => onAcknowledge(injectionSignature(gate.findings))}
            style={{
              flex: "0 0 auto", fontFamily: MONO, fontSize: 10, fontWeight: 600, color: "oklch(0.20 0.04 70)",
              background: "var(--accent)", border: "none", borderRadius: "var(--r-sm)", padding: "5px 11px", cursor: "pointer", whiteSpace: "nowrap",
            }}
          >I&apos;ve reviewed these</button>
        )}
      </Row>
    </Box>
  );
}
