import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { Card } from "@/shared/ui/data/Card";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import {
  loadShellKind,
  saveShellKind,
  coerceShellKind,
  SHELL_OPTIONS,
  type ShellKind,
} from "@/shared/lib/core/shellConfig";

export function ShellSelectorCard() {
  const [kind, setKind] = useState<ShellKind>(() => loadShellKind());

  useEffect(() => {
    let live = true;
    invoke<string>("get_preferred_shell")
      .then((v) => { if (live) setKind(coerceShellKind(v)); })
      .catch(() => { /* keep the local value */ });
    return () => { live = false; };
  }, []);

  function choose(next: ShellKind) {
    setKind(next);
    saveShellKind(next);
    fireInvoke("set_preferred_shell", { kind: next }, (e) => console.error("set_preferred_shell failed", e));
  }

  const active = SHELL_OPTIONS.find((o) => o.kind === kind) ?? SHELL_OPTIONS[0];

  return (
    <Card title="Console shell" hint="the shell new console sessions launch under · applies to the next launch">
      <Row gap={6} align="stretch" wrap>
        {SHELL_OPTIONS.map((o) => {
          const on = o.kind === kind;
          return (
            <Box
              key={o.kind}
              className="mono"
              onClick={() => choose(o.kind)}
              pad={[6, 12]} bg={on ? "var(--accent)" : "var(--bg-elev)"} radius={6} style={{ cursor: "pointer",
                fontSize: 11,
                color: on ? "var(--on-accent)" : "var(--fg-muted)",
                border: "1px solid " + (on ? "transparent" : "var(--border-soft)"),
                fontWeight: on ? 600 : 400,
              }}
            >{o.label}</Box>
          );
        })}
      </Row>
      <Box className="hint" style={{ marginTop: 10, lineHeight: 1.55 }}>
        {active.note}
        {!active.helpersFull && (
          <>
            {" "}
            <Text as="span" style={{ color: "#e5c07b" }}>
              ⚠ The bsc-* helpers (checkpoint, notes, coordination) and startup-prompt
              injection are bash-only — sessions under this shell run without them.
            </Text>
          </>
        )}
      </Box>
    </Card>
  );
}
