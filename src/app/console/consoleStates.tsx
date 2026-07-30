// Console pane placeholder states (#2128, extracted from console/index.tsx) — the three non-terminal
// cards a pane renders instead of its TerminalView: disabled (session stopped by the user), ended (a
// fleet worker auto-ended after its PTY exited, #920), and dormant (idle-reaped to free memory, #849).
// Pure presentational (props in, callbacks out); behavior-preserving move.
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import type { EndedInfo } from "@/store/types";
import { useEffect, useState } from "react";
import { Row } from "@/shared/ui/layout/Row";
import { loadDoneAudit, type DoneAudit } from "@/shared/lib/fleet/workerAudit";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

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

/**
 * The COMPLETED card (#4027) — a worker that finished everything it owns and had its PTY reclaimed.
 *
 * `DormantConsole` is the wrong card for this: it reports a memory optimisation ("reaped after idle to
 * free memory") when the answer the user wants is *what the worker did*. And with maintenance now
 * reaped immediately (#4025), this is the state most finished workers sit in.
 *
 * The audit is PTY-independent by construction — `loadDoneAudit` reads the worktree and GitHub at view
 * time — which is exactly why the history survives the session being reclaimed. Loaded here rather than
 * threaded in, because it is only ever wanted for a pane in this state.
 */
export function CompletedConsole(
  { cwd, repo, note, onWake }: { cwd: string; repo: string; note?: string; onWake: () => void },
) {
  const [audit, setAudit] = useState<DoneAudit | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadDoneAudit(cwd, repo)
      .then((a) => { if (!cancelled) setAudit(a); })
      .catch(() => { /* loadDoneAudit never rejects; belt-and-braces */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, repo]);

  const row = (label: string, value: string) => (
    <Row gap={8} style={{ width: "100%", maxWidth: 420 }}>
      <Text as="span" tone="dim" size={10} style={{ width: 92, flex: "none", textAlign: "right" }}>{label}</Text>
      <Text as="span" size={10} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</Text>
    </Row>
  );

  return (
    <Stack className="mono" align="center" justify="center" gap={10} style={{
      flex: 1, padding: 16, background: "var(--bg-canvas)", color: "var(--fg-dim)", fontSize: 11,
    }}>
      <Text as="span" weight={600} style={{ color: "var(--graph-health-healthy)" }}>✓ complete</Text>
      <Text as="span" tone="muted" style={{ maxWidth: 360, textAlign: "center", lineHeight: 1.5 }}>
        {note || "every owned issue complete — standing by for dispatch"}
      </Text>
      {loading ? (
        <Text tone="dim" size={10}>reading the worktree…</Text>
      ) : audit ? (
        <Stack gap={3} align="center" style={{ width: "100%" }}>
          {audit.branch && row("branch", audit.branch)}
          {audit.commits.length > 0 && row("commits", `${audit.commits.length}`)}
          {audit.changedFiles.length > 0 && row("uncommitted", `${audit.changedFiles.length} file(s)`)}
          {audit.pr && row("pr", `#${audit.pr.number} · ${audit.pr.state}`)}
          {/* The transcript is the session's actual conversation — the thing the reclaimed PTY held. */}
          {audit.transcriptPath && (
            <Button onClick={() => { void revealItemInDir(audit.transcriptPath!).catch(() => {}); }}
              title={audit.transcriptPath}>transcript ↗</Button>
          )}
        </Stack>
      ) : null}
      {/* Wake, not "resume": the session is gone, so this relaunches it — the same path a director
          dispatch takes (#4025), which is why reclaiming it costs nothing. */}
      <Button onClick={onWake}>wake</Button>
    </Stack>
  );
}
