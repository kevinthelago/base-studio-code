// Context stage body (#652/#1061, split from FocusedBodies.tsx #1757) — the context-file list +
// the required-context written/missing checklist.
import type { ContextFile } from "@/features/planner/pane/projectPaneData";
import { KindDot } from "@/features/planner/pane/focusedPrimitives";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";

function CtxRow({ f, onToggle, onView }: { f: ContextFile; onToggle?: () => void; onView?: () => void }) {
  return (
    <Row onClick={onView} gap={7} style={{
      padding: "5px 7px",
      borderRadius: 5, background: f.pinned ? "var(--bg-canvas)" : "transparent",
      border: "1px solid " + (f.pinned ? "var(--border-soft)" : "transparent"),
      cursor: onView ? "pointer" : "default",
    }}>
      <KindDot kind={f.kind} />
      <Text as="span" mono size={10} style={{
        flex: 1, color: f.pinned ? "var(--fg)" : "var(--fg-muted)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>{f.name}</Text>
      <Text as="span" mono size={8.5} tone="dim">{f.tok}</Text>
      <Text as="span" onClick={(e: MouseEvent) => { e.stopPropagation(); onToggle?.(); }} mono size={11} style={{
        cursor: "pointer",
        color: f.pinned ? "var(--accent)" : "var(--fg-dim)", width: 14, textAlign: "center",
      }}>
        {f.pinned ? "✦" : "+"}
      </Text>
    </Row>
  );
}

/** One row of the required-context checklist (#1061): names a required topic's `<topic>.md`
 *  and whether it's been written yet, so the user sees exactly which files the gate still needs. */
function RequiredCtxRow({ topic, written }: { topic: string; written: boolean }) {
  return (
    <Row className="mono" gap={7} style={{
      padding: "4px 7px", borderRadius: 5,
      fontSize: 10,
    }}>
      <Text as="span" style={{ width: 12, textAlign: "center", color: written ? "var(--success)" : "var(--fg-dim)" }}>
        {written ? "✓" : "○"}
      </Text>
      <Text as="span" style={{ flex: 1, color: written ? "var(--fg-muted)" : "var(--fg)" }}>{topic}.md</Text>
      {!written && (
        <Text as="span" size={8.5} tone="danger" style={{ letterSpacing: ".04em", textTransform: "uppercase" }}>
          missing
        </Text>
      )}
    </Row>
  );
}

export function DiscoveryBody({ context, onView, requiredContext }: {
  context?: ContextFile[]; onView?: (f: ContextFile) => void; requiredContext?: string[];
}) {
  const files = context ?? [];
  const required = requiredContext ?? [];
  // A topic is satisfied once its `<topic>.md` exists (the gate keys on generation, #1028).
  const written = new Set(files.map((f) => f.name.replace(/\.md$/i, "")));
  const missingCount = required.filter((t) => !written.has(t)).length;
  if (files.length === 0 && required.length === 0) {
    return <EmptyState iconVariant="dashed" icon="✦" title="No context files yet" />;
  }
  const totalTok = files.reduce((s, f) => s + parseFloat(f.tok), 0);
  return (
    <Box>
      {required.length > 0 && (
        <Box style={{ marginBottom: 12 }}>
          <Row gap={8} style={{ padding: "0 2px 6px" }}>
            <Box as="span" className="ulabel">required files</Box>
            <Spacer />
            <Text as="span" mono size={9} style={{
              color: missingCount === 0 ? "var(--success)" : "var(--fg-dim)",
            }}>
              {required.length - missingCount}/{required.length} written
            </Text>
          </Row>
          <Stack gap={2}>
            {required.map((t) => <RequiredCtxRow key={t} topic={t} written={written.has(t)} />)}
          </Stack>
        </Box>
      )}
      <Row gap={8} style={{ padding: "0 2px 8px" }}>
        <Box as="span" className="ulabel">context files</Box>
        <Spacer />
        <Text as="span" mono size={9} tone="accent">
          {totalTok.toFixed(1)}k / 200k tok
        </Text>
      </Row>
      <Stack gap={4}>
        {files.map((f) => <CtxRow key={f.name} f={f} onView={onView ? () => onView(f) : undefined} />)}
      </Stack>
    </Box>
  );
}
