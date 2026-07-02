// Console pane placeholder states (#2128, extracted from console/index.tsx) — the three non-terminal
// cards a pane renders instead of its TerminalView: disabled (session stopped by the user), ended (a
// fleet worker auto-ended after its PTY exited, #920), and dormant (idle-reaped to free memory, #849).
// Pure presentational (props in, callbacks out); behavior-preserving move.
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import type { EndedInfo } from "@/store/types";

export function DisabledConsole({ onEnable }: { onEnable: () => void }) {
  return (
    <Stack className="mono" align="center" justify="center" gap={12} style={{
      flex: 1,
      background: "var(--bg-canvas)", color: "var(--fg-dim)",
      fontSize: 11,
    }}>
      <Text as="span">console disabled · session stopped</Text>
      <Button onClick={onEnable}>enable</Button>
    </Stack>
  );
}

/** Resting card for a fleet worker auto-ended after its PTY exited (#920). State + summary
 *  come from plan.db owned-issue status (done / needs-attention / blocked). Persisted +
 *  recovery-gated, so it survives a restart (the worker is never silently re-opened); the
 *  full audit lives on the worker's detail page. Reopen relaunches the session. */
export function EndedConsole({ info, onReopen }: { info: EndedInfo; onReopen: () => void }) {
  const tone =
    info.state === "done" ? { color: "var(--success, #2ea043)", label: "✓ finished" }
    : info.state === "blocked" ? { color: "var(--danger)", label: "■ blocked / failed" }
    : { color: "var(--accent)", label: "▲ stopped early" };
  return (
    <Stack className="mono" align="center" justify="center" gap={10} style={{
      flex: 1, padding: 16, textAlign: "center",
      background: "var(--bg-canvas)", color: "var(--fg-dim)", fontSize: 11,
    }}>
      <Text as="span" weight={600} style={{ color: tone.color }}>{tone.label}</Text>
      <Text as="span" tone="muted" style={{ maxWidth: 320, lineHeight: 1.5 }}>{info.summary}</Text>
      <Text tone="dim" size={10}>session ended · audit on the worker detail page</Text>
      <Button onClick={onReopen}>reopen</Button>
    </Stack>
  );
}

/** Placeholder for an idle-reaped pane (#849): its PTY was killed to free memory after a
 *  long idle. Resuming relaunches the session (its cwd persists; `--continue` resumes the
 *  conversation), so reaping is non-destructive. */
export function DormantConsole({ onResume }: { onResume: () => void }) {
  return (
    <Stack className="mono" align="center" justify="center" gap={12} style={{
      flex: 1,
      background: "var(--bg-canvas)", color: "var(--fg-dim)",
      fontSize: 11,
    }}>
      <Text as="span">session dormant · reaped after idle to free memory</Text>
      <Button onClick={onResume}>resume</Button>
    </Stack>
  );
}
