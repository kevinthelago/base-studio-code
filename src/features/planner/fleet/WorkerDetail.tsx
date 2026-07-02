// Per-agent page (#499) — opened from the Fleet worker board. Analytics + options
// for a single worker (a launched fleet pane/stream). Real data drives the header,
// permissions (its AgentProfile), execution flow (its AgentFlow), owned issues
// (its stream), and live status; per-stream analytics not yet tracked show explicit
// "not measured yet" placeholders (same honesty as Fleet's tokens card).
import { useState, useEffect } from "react";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { BackButton } from "@/shared/ui/controls/BackButton";
import { ModalScrim } from "@/shared/ui/overlay/ModalScrim";
import { invoke } from "@tauri-apps/api/core";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { usePoll } from "@/shared/hooks/usePoll";
import { CardHead, StatCard, Avatar } from "@/shared/ui/charts";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Card } from "@/shared/ui/data/Card";
import { useAppStore } from "@/store";
import { STATUS } from "@/shared/data/fleet";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { resolveFlow } from "./agentFlow";
import { permissionRows, flowRows, paneCoords } from "./fleetWorker";
import { parseAuditLog, type AuditRecord } from "@/features/agents/lib/auditLog";
import { loadDoneAudit, type DoneAudit } from "@/shared/lib/fleet/workerAudit";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { LiveWorker } from "@/shared/lib/fleet/fleetLive";

const TIER_COLOR: Record<string, string> = {
  allow: "var(--success)", ask: "var(--accent)", deny: "var(--danger)",
};

function Modal({ title, children, onClose, footer }: {
  title: string; children: React.ReactNode; onClose: () => void; footer?: React.ReactNode;
}) {
  return (
    <ModalScrim onDismiss={onClose}>
      <Box style={{ width: 440, maxWidth: "90vw", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }}>
        <Row style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-soft)" }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <Spacer />
          <IconButton aria-label="close" onClick={onClose} />
        </Row>
        <Box style={{ padding: 16 }}>{children}</Box>
        {footer && <Row justify="end" align="stretch" gap={8} style={{ padding: "12px 16px", borderTop: "1px solid var(--border-soft)" }}>{footer}</Row>}
      </Box>
    </ModalScrim>
  );
}

function Placeholder({ title, hint, body }: { title: string; hint: string; body: string }) {
  return (
    <Card>
      <CardHead title={title} hint={hint} />
      <Text as="div" mono size={11} tone="dim" style={{ lineHeight: 1.6 }}>{body}</Text>
    </Card>
  );
}

export function WorkerDetail({ worker, onBack }: { worker: LiveWorker; onBack: () => void }) {
  const stream      = useAppStore((s) => s.fleetPaneStreams[worker.id]);
  const profileId   = useAppStore((s) => s.paneProfiles[worker.id]);
  const agentProfiles = useAppStore((s) => s.agentProfiles);
  const paneFlow    = useAppStore((s) => s.paneFlows[worker.id]);
  const setWorkspace   = useAppStore((s) => s.setWorkspace);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const setPaneDisabled = useAppStore((s) => s.setPaneDisabled);
  const setPaneProfile = useAppStore((s) => s.setPaneProfile);
  const paused = useAppStore((s) => !!s.disabledPanes[worker.id]);
  const cwd = useAppStore((s) => s.paneCwds[worker.id]);
  // Auto-end verdict (#920): present once the worker's PTY exited and its issues were evaluated.
  const ended = useAppStore((s) => s.endedPanes[worker.id]);

  const profile = profileId ? agentProfiles.find((p) => p.id === profileId) : undefined;
  const flow = resolveFlow(paneFlow ?? stream?.flow);
  const owned = stream?.issues ?? [];
  const st = STATUS[worker.status];

  const [modal, setModal] = useState<null | "steer" | "answer" | "stop" | "profile">(null);
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

  // Real per-worker activity from the bsc-audit log (#257): tool attempts tagged
  // with this pane id, polled while the page is open, newest first.
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  usePoll((isCancelled) => invoke<string[]>("read_audit_log", { limit: 4000 })
    .then((lines) => {
      if (isCancelled()) return;
      const rows = parseAuditLog((lines ?? []).join("\n")).filter((r) => r.pane === worker.id);
      setAudit(rows.slice(-12).reverse());
    })
    .catch(() => {}), 4000, [worker.id]);

  // Done-time audit snapshot (#920): the worker's concrete output — branch, commits, changed
  // files, PR, and the transcript path — read from the worktree at view time. Reloads when the
  // ended verdict lands so a just-finished worker shows its final snapshot.
  const [doneAudit, setDoneAudit] = useState<DoneAudit | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!cwd) return; // the render shows "no worktree bound"; nothing to load
    loadDoneAudit(cwd, worker.repo).then((a) => { if (!cancelled) setDoneAudit(a); }).catch(() => {});
    return () => { cancelled = true; };
  }, [cwd, worker.repo, ended?.at]);

  function openSession() {
    const c = paneCoords(worker.id);
    setWorkspace("console");
    if (c) { setActiveTab(c.tab); setFocusedPane(c.pane); }
    flash(`Opened ${worker.name}'s session`);
  }
  function send(kind: "steer" | "answer") {
    const text = draft.trim();
    if (text) fireInvoke("pty_write", { paneId: worker.id, data: text + "\r" });
    setModal(null); setDraft("");
    flash(kind === "answer" ? "Answer sent · worker resuming" : "Message sent to worker");
  }
  function stop() {
    setPaneDisabled(worker.id, true);
    setModal(null);
    onBack();
  }

  const perms = permissionRows(profile);
  const half = Math.ceil(perms.length / 2);

  return (
    <section style={{ flex: 1, overflow: "auto", minWidth: 0, background: "var(--bg-canvas)" }}>
      {/* sticky header + actions */}
      <Box style={{ position: "sticky", top: 0, zIndex: 50, background: "var(--bg-panel)", borderBottom: "1px solid var(--border-soft)", padding: "12px 24px" }}>
        <Box style={{ maxWidth: 1180, margin: "0 auto" }}>
          <Row gap={12} style={{ marginBottom: 12 }}>
            <BackButton variant="icon" onClick={onBack} aria-label="Back to fleet" />
            <Box style={{ width: 1, height: 18, background: "var(--border-soft)" }} />
            <Avatar login={worker.name} bot size={26} />
            <Box style={{ minWidth: 0 }}>
              <Row gap={9}>
                <Text as="span" mono size={15} style={{ color: "var(--fg)" }}>{worker.name}</Text>
                <Box as="span" className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10.5, color: paused ? "var(--fg-dim)" : st.color }}>
                  <Box as="span" style={{ width: 7, height: 7, borderRadius: 99, background: paused ? "var(--fg-dim)" : st.color }} />{paused ? "paused" : st.label}
                </Box>
              </Row>
              <Text as="div" mono size={10} tone="dim" style={{ marginTop: 2 }}>
                {worker.id} · {worker.repo} · <Text as="span" style={{ color: worker.profileColor }}>{worker.profileLabel}</Text>
              </Text>
            </Box>
          </Row>
          <Row gap={8} wrap>
            {worker.status === "asking" && <button className="btn primary" onClick={() => setModal("answer")}>answer question →</button>}
            <button className="btn" onClick={() => { setPaneDisabled(worker.id, !paused); flash(paused ? "Worker resumed" : "Worker paused"); }}>
              {paused ? "▶ resume" : "⏸ pause"}
            </button>
            <button className="btn ghost" onClick={() => setModal("steer")}>✎ steer</button>
            <button className="btn ghost" onClick={openSession}>▤ open session</button>
            <button className="btn ghost" onClick={() => setModal("profile")}>⛉ profile</button>
            <Spacer />
            <button className="btn danger" onClick={() => setModal("stop")}>stop &amp; remove</button>
          </Row>
        </Box>
      </Box>

      <Box style={{ maxWidth: 1180, margin: "0 auto", padding: "18px 24px" }}>
        {/* current / parked banner */}
        <Card style={{ padding: "12px 16px", marginBottom: 14,
          borderColor: worker.note ? st.color : "var(--border-soft)",
          background: worker.note ? `color-mix(in oklch, ${st.color}, transparent 92%)` : "var(--bg-panel)" }}>
          <Row gap={10} wrap>
            <Box as="span" className="mono-label">current</Box>
            <Box as="span" className="mono-value">{worker.issue}</Box>
            {worker.note && <Text as="span" mono size={11} style={{ color: st.color }}>· {worker.note}</Text>}
          </Row>
        </Card>

        {/* KPIs — real where measured, explicit "—" otherwise */}
        <Box className="statgrid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 14 }}>
          <StatCard k="issues owned" v={String(owned.length)} sub="assigned to this stream" tone="fg" />
          <StatCard k="profile" v={(profile?.name ?? worker.profileLabel).split(" ")[0]} sub={profile?.origin ?? "—"} tone="fg" />
          <StatCard k="status" v={st.label} sub="right now" tone={worker.status === "running" ? "accent" : worker.status === "blocked" ? "danger" : "fg"} />
          <StatCard k="repo" v={worker.repo.split("/")[1] ?? worker.repo} sub="worktree" tone="info" />
        </Box>

        <Grid cols="1.6fr 1fr" gap={14}>
          <Stack gap={14} style={{ minWidth: 0 }}>
            {/* Owned issues (real) */}
            <Card>
              <CardHead title="Owned issues" hint={`${owned.length} assigned to this stream`} />
              {owned.length === 0
                ? <Box className="hint mono" style={{ fontSize: 11 }}>No issues assigned to this stream.</Box>
                : (
                  <Stack gap={1} style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                    {owned.map((ref, i) => (
                      <Grid key={ref} cols="1fr 70px" gap={8} align="center" className="hrow" style={{ padding: "9px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
                        <Text as="span" mono style={{ color: "var(--fg)" }}>{ref}</Text>
                        <Text as="span" mono size={10} style={{ textAlign: "right", color: ref === worker.issue ? st.color : "var(--fg-dim)" }}>
                          ● {ref === worker.issue ? worker.status : "owned"}
                        </Text>
                      </Grid>
                    ))}
                  </Stack>
                )}
            </Card>
            <Card>
              <CardHead
                title="Done-time audit"
                hint={ended ? `ended ${ended.state} · ${ended.summary}` : "live snapshot of this worker's output"}
              />
              {!cwd ? (
                <Box className="hint mono" style={{ fontSize: 11 }}>No worktree bound to this pane.</Box>
              ) : !doneAudit ? (
                <Box className="hint mono" style={{ fontSize: 11 }}>reading the worktree…</Box>
              ) : (
                <Stack gap={10}>
                  {/* branch + PR + transcript */}
                  <Row className="mono" gap={8} wrap style={{ fontSize: 10.5 }}>
                    {doneAudit.branch && (
                      <Box as="span" style={{ padding: "2px 8px", borderRadius: 99, border: "1px solid var(--border-soft)", color: "var(--fg-muted)" }}>⎇ {doneAudit.branch}</Box>
                    )}
                    {doneAudit.pr ? (
                      <button
                        onClick={() => openUrl(doneAudit.pr!.url).catch(() => {})}
                        title="Open the pull request"
                        className="mono"
                        style={{ padding: "2px 9px", borderRadius: 99, cursor: "pointer", fontSize: 10.5,
                          color: doneAudit.pr.merged ? "var(--success)" : "var(--accent)",
                          background: `color-mix(in oklch, ${doneAudit.pr.merged ? "var(--success)" : "var(--accent)"}, transparent 88%)`,
                          border: `1px solid color-mix(in oklch, ${doneAudit.pr.merged ? "var(--success)" : "var(--accent)"}, transparent 65%)` }}
                      >
                        {doneAudit.pr.merged ? "✓ merged" : doneAudit.pr.state.toLowerCase()} · PR #{doneAudit.pr.number} ↗
                      </button>
                    ) : (
                      <Text as="span" tone="dim">no PR yet</Text>
                    )}
                    <Spacer />
                    {doneAudit.transcriptPath && (
                      <button className="btn ghost" style={{ height: 22, fontSize: 10 }}
                        onClick={() => revealItemInDir(doneAudit.transcriptPath!).catch(() => {})}
                        title={doneAudit.transcriptPath}>transcript ↗</button>
                    )}
                  </Row>
                  {/* changed files + commits */}
                  <Text as="div" mono size={10} tone="dim">
                    {doneAudit.changedFiles.length} uncommitted file{doneAudit.changedFiles.length === 1 ? "" : "s"} · {doneAudit.commits.length} recent commit{doneAudit.commits.length === 1 ? "" : "s"}
                  </Text>
                  {doneAudit.commits.length > 0 && (
                    <Stack gap={1} style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                      {doneAudit.commits.slice(0, 8).map((c, i) => (
                        <Grid key={c.hash + i} cols="60px 1fr" gap={8} align="center" style={{ padding: "7px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
                          <Text as="span" mono size={9.5} tone="accent">{c.hash}</Text>
                          <Text as="span" mono size={10} tone="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.subject}</Text>
                        </Grid>
                      ))}
                    </Stack>
                  )}
                </Stack>
              )}
            </Card>
            <Card>
              <CardHead title="Activity & audit" hint={`this worker · ${audit.length ? "tool attempts, newest first" : "from the bsc-audit log"}`} />
              {audit.length === 0
                ? <Box className="hint mono" style={{ fontSize: 11 }}>
                    No tool attempts logged yet for this worker. Gated panes append one line per tool use here.
                  </Box>
                : (
                  <Stack gap={1} style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                    {audit.map((a, i) => (
                      <Grid key={i} cols="62px 1fr" gap={8} align="center" className="hrow" style={{ padding: "8px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
                        <Text as="span" mono size={9.5} tone="accent">{a.toolName}</Text>
                        <Text as="span" mono size={10} tone="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.target || "—"}</Text>
                      </Grid>
                    ))}
                  </Stack>
                )}
            </Card>
          </Stack>

          <Stack gap={14} style={{ minWidth: 0 }}>
            {/* Permissions (real, from the profile) */}
            <Card>
              <CardHead title="Permissions" hint={profile ? `${profile.name} · ${profile.origin}` : "no profile assigned"} />
              {profile ? (
                <>
                  <Grid cols={2} style={{ gap: "5px 18px", marginBottom: 12 }}>
                    {[perms.slice(0, half), perms.slice(half)].flat().map((r) => (
                      <Row key={r.key} gap={8} className="mono" style={{ fontSize: 10.5 }}>
                        <Box as="span" style={{ width: 7, height: 7, borderRadius: 99, background: TIER_COLOR[r.tier], flexShrink: 0 }} />
                        <Text as="span" style={{ color: "var(--fg)", width: 42 }}>{r.key}</Text>
                        <Text as="span" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</Text>
                      </Row>
                    ))}
                  </Grid>
                  <Stack className="mono" gap={6} style={{ borderTop: "1px solid var(--border-soft)", paddingTop: 10, fontSize: 10, color: "var(--fg-muted)" }}>
                    <Box><Text as="span" tone="dim">paths allow </Text>{profile.paths.allow.length ? profile.paths.allow.join(", ") : "—"}</Box>
                    <Box><Text as="span" tone="dim">paths deny </Text>{profile.paths.deny.length ? profile.paths.deny.join(", ") : "—"}</Box>
                    <Box><Text as="span" tone="dim">network </Text>{profile.net.allow.length ? profile.net.allow.join(", ") : "none"}</Box>
                  </Stack>
                </>
              ) : (
                <Box className="hint mono" style={{ fontSize: 11 }}>
                  This worker runs under its role gate only — no least-privilege profile was assigned during planning.
                </Box>
              )}
            </Card>

            {/* Execution flow (real, from the flow) */}
            <Card>
              <CardHead title="Execution flow" hint="set during planning" />
              <Stack gap={1} style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                {flowRows(flow).map((r, i) => (
                  <Grid key={r.key} cols="80px 110px 1fr" gap={8} align="center" style={{ padding: "8px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
                    <Text as="span" mono size={10} tone="dim">{r.key}</Text>
                    <Text as="span" mono size={10.5} tone="accent">{r.value}</Text>
                    <Text as="span" size={10} tone="muted">{r.desc}</Text>
                  </Grid>
                ))}
              </Stack>
            </Card>

            <Placeholder title="Tokens & spend" hint="not measured yet"
              body="Per-session token + cost accounting isn't wired up yet. Once it lands, this worker's token burn and spend appear here." />
          </Stack>
        </Grid>
      </Box>

      {toast && (
        <Box className="above-modal mono" style={{ position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)",
          background: "var(--bg-elev2)", border: "1px solid var(--border)", borderRadius: 8, padding: "9px 16px",
          fontSize: 11.5, color: "var(--fg)", boxShadow: "0 6px 24px rgba(0,0,0,0.4)" }}>{toast}</Box>
      )}

      {(modal === "steer" || modal === "answer") && (
        <Modal title={modal === "answer" ? `Answer ${worker.name}` : `Steer ${worker.name}`} onClose={() => setModal(null)}
          footer={<>
            <button className="btn ghost" onClick={() => setModal(null)}>cancel</button>
            <button className="btn primary" onClick={() => send(modal)}>{modal === "answer" ? "send answer" : "send"}</button>
          </>}>
          {modal === "answer" && worker.note && (
            <Box className="mono" style={{ padding: "10px 12px", borderRadius: 8, background: `color-mix(in oklch, ${st.color}, transparent 90%)`, border: `1px solid color-mix(in oklch, ${st.color}, transparent 70%)`, marginBottom: 10, fontSize: 11.5, color: "var(--fg)" }}>
              {worker.note}
            </Box>
          )}
          <Box className="hint" style={{ marginBottom: 8 }}>Typed straight into this worker's running session.</Box>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
            placeholder={modal === "answer" ? "your decision…" : "e.g. skip the migration; focus on the API contract"}
            className="mono"
            style={{ width: "100%", minHeight: 84, resize: "vertical", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: 10, color: "var(--fg)", fontSize: 12, outline: "none" }} />
        </Modal>
      )}
      {modal === "stop" && (
        <Modal title="Stop & remove worker" onClose={() => setModal(null)}
          footer={<>
            <button className="btn ghost" onClick={() => setModal(null)}>cancel</button>
            <button className="btn danger" onClick={stop}>stop &amp; remove</button>
          </>}>
          <Text as="div" size={12} tone="muted" style={{ lineHeight: 1.6 }}>
            This stops <b style={{ color: "var(--fg)" }}>{worker.name}</b>'s session (disables its pane). Its worktree is
            preserved; re-enable the console to resume.
          </Text>
        </Modal>
      )}
      {modal === "profile" && (
        <Modal title="Change profile" onClose={() => setModal(null)}>
          <Box className="hint" style={{ marginBottom: 10 }}>Switch the least-privilege profile this worker runs under (applies on its next launch).</Box>
          <Stack gap={6} style={{ maxHeight: 360, overflow: "auto" }}>
            {agentProfiles.map((p) => (
              <button key={p.id} onClick={() => { setPaneProfile(worker.id, p.id); setModal(null); flash(`Profile → ${p.name}`); }} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", textAlign: "left", cursor: "pointer",
                background: p.id === profileId ? "var(--bg-elev2)" : "var(--bg-elev)", color: "var(--fg)",
                border: "1px solid " + (p.id === profileId ? p.color : "var(--border-soft)"), borderRadius: 8,
              }}>
                <ColorSwatch color={p.color} size={8} />
                <Text as="span" mono size={11.5} style={{ flex: 1 }}>{p.name}</Text>
                <Text as="span" mono size={9.5} tone="dim">base {p.mode}</Text>
                {p.id === profileId && <Text as="span" mono size={9.5} style={{ color: p.color }}>current</Text>}
              </button>
            ))}
          </Stack>
        </Modal>
      )}
    </section>
  );
}
