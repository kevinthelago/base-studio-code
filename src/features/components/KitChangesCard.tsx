// Kit-change propagation — the notify surface (#2277). Renders the pending fan-out queue (`kitDispatches`,
// produced by setComponent's change origin) so a released kit change and its affected consumers are
// visible, with the per-consumer AUTO-DISPATCH toggle (default OFF ⇒ notify-only) and a dismiss. When a
// consumer's toggle is ON, the drain (useKitDispatch) delivers BREAKING changes to its fleet/GitHub and
// clears the entry; until then this is where a change lands. Self-contained: reads the store directly and
// renders nothing when the queue is empty, so it's safe to drop into the Design Studio unconditionally.
import { useMemo } from "react";
import { useAppStore } from "@/store";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { Chip } from "@/shared/ui/data/Chip";
import type { KitChange } from "./lib/propagation";

const CLASS_COLOR: Record<KitChange["class"], string> = {
  breaking: "var(--danger)",
  additive: "var(--accent)",
  fix: "var(--success)",
};

export function KitChangesCard() {
  const dispatches = useAppStore((s) => s.kitDispatches);
  const autoKitDispatch = useAppStore((s) => s.autoKitDispatch);
  const setAutoKitDispatch = useAppStore((s) => s.setAutoKitDispatch);
  const dismiss = useAppStore((s) => s.dismissKitDispatch);

  // Group the flat (consumer, change) queue by change, so one released change lists its consumers once.
  const groups = useMemo(() => {
    const m = new Map<string, { change: KitChange; projects: string[] }>();
    for (const d of dispatches) {
      const g = m.get(d.change.id);
      if (g) g.projects.push(d.projectKey);
      else m.set(d.change.id, { change: d.change, projects: [d.projectKey] });
    }
    return [...m.values()];
  }, [dispatches]);

  if (groups.length === 0) return null;

  return (
    <Box
      style={{
        margin: "10px 14px 0", border: "1px solid var(--border)", borderRadius: 10,
        background: "var(--bg-soft)", overflow: "hidden", flex: "none",
      }}
    >
      <Box style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
        <Text mono size="xxs" tone="dim" style={{ letterSpacing: ".06em", textTransform: "uppercase" }}>Kit changes</Text>
        <Chip color="var(--accent)">{dispatches.length} pending</Chip>
        <Box style={{ flex: 1 }} />
        <Text size={11} tone="muted">notify-only until a consumer opts into auto-dispatch</Text>
      </Box>
      <Box style={{ display: "flex", flexDirection: "column" }}>
        {groups.map(({ change, projects }) => (
          <Box key={change.id} style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-soft, var(--border))" }}>
            <Box style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Chip color={CLASS_COLOR[change.class]}>{change.class}</Chip>
              <Text weight={600} size={12.5}>{change.component}</Text>
              {change.from && change.to && <Text mono size="xxs" tone="muted">{change.from} → {change.to}</Text>}
              <Text size={12} tone="muted">— {change.summary}</Text>
            </Box>
            {change.migration && (
              <Text size={11.5} tone="muted" as="div" style={{ marginTop: 4 }}>Migration: {change.migration}</Text>
            )}
            <Box style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8, paddingLeft: 10, borderLeft: "1px dashed var(--border)" }}>
              {projects.map((pk) => {
                const auto = !!autoKitDispatch[pk];
                return (
                  <Box key={pk} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Text mono size="xxs" tone="dim" style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pk}</Text>
                    <Button
                      size="sm"
                      variant={auto ? "primary" : "ghost"}
                      onClick={() => setAutoKitDispatch(pk, !auto)}
                      title={auto ? "Auto-dispatch ON — breaking changes route to this project's fleet/GitHub" : "Notify-only — click to auto-dispatch breaking changes"}
                    >
                      {auto ? "auto ✓" : "auto"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => dismiss(pk, change.id)}>dismiss</Button>
                  </Box>
                );
              })}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
