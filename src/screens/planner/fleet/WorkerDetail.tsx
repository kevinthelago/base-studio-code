// Per-agent page (#499) — opened from the Fleet worker board. Analytics + options
// for a single worker (a launched fleet pane/stream). Real data drives the header,
// permissions (its AgentProfile), execution flow (its AgentFlow), owned issues
// (its stream), and live status; per-stream analytics not yet tracked show explicit
// "not measured yet" placeholders (same honesty as Fleet's tokens card).
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { CardHead, StatCard, Avatar } from "../../../components/charts";
import { useAppStore } from "../../../store";
import { STATUS } from "../../../data/fleet";
import { resolveFlow } from "./agentFlow";
import { permissionRows, flowRows, paneCoords } from "./fleetWorker";
import { parseAuditLog, type AuditRecord } from "../../agents/auditLog";
import { loadDoneAudit, type DoneAudit } from "../../../lib/fleet/workerAudit";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { LiveWorker } from "../../../lib/fleet/fleetLive";

const TIER_COLOR: Record<string, string> = {
  allow: "var(--success)", ask: "var(--accent)", deny: "var(--danger)",
};

function Modal({ title, children, onClose, footer }: {
  title: string; children: React.ReactNode; onClose: () => void; footer?: React.ReactNode;
}) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 440, maxWidth: "90vw", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-soft)", display: "flex", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" style={{ height: 24, width: 24, padding: 0, fontSize: 14 }} onClick={onClose}>×</button>
        </div>
        <div style={{ padding: 16 }}>{children}</div>
        {footer && <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border-soft)", display: "flex", justifyContent: "flex-end", gap: 8 }}>{footer}</div>}
      </div>
    </div>
  );
}

function Placeholder({ title, hint, body }: { title: string; hint: string; body: string }) {
  return (
    <div className="card">
      <CardHead title={title} hint={hint} />
      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", lineHeight: 1.6 }}>{body}</div>
    </div>
  );
}

export function WorkerDetail({ worker, onBack }: { worker: LiveWorker; onBack: () => void }) {
  const stream      = useAppStore((s) => s.fleetPaneStreams[worker.id]);
  const profileId   = useAppStore((s) => s.paneProfiles[worker.id]);
  const agentProfiles = useAppStore((s) => s.agentProfiles);
  const paneFlow    = useAppStore((s) => s.paneFlows[worker.id]);
  const setScreen   = useAppStore((s) => s.setScreen);
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
  useEffect(() => {
    let cancelled = false;
    const load = () => invoke<string[]>("read_audit_log", { limit: 4000 })
      .then((lines) => {
        if (cancelled) return;
        const rows = parseAuditLog((lines ?? []).join("\n")).filter((r) => r.pane === worker.id);
        setAudit(rows.slice(-12).reverse());
      })
      .catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [worker.id]);

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
    setScreen("console");
    if (c) { setActiveTab(c.tab); setFocusedPane(c.pane); }
    flash(`Opened ${worker.name}'s session`);
  }
  function send(kind: "steer" | "answer") {
    const text = draft.trim();
    if (text) invoke("pty_write", { paneId: worker.id, data: text + "\r" }).catch(() => {});
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
      <div style={{ position: "sticky", top: 0, zIndex: 50, background: "var(--bg-panel)", borderBottom: "1px solid var(--border-soft)", padding: "12px 24px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <button className="btn ghost" onClick={onBack} style={{ height: 26 }}>← fleet</button>
            <div style={{ width: 1, height: 18, background: "var(--border-soft)" }} />
            <Avatar login={worker.name} bot size={26} />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 15, color: "var(--fg)" }}>{worker.name}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 10.5, color: paused ? "var(--fg-dim)" : st.color }}>
                  <span style={{ width: 7, height: 7, borderRadius: 99, background: paused ? "var(--fg-dim)" : st.color }} />{paused ? "paused" : st.label}
                </span>
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", marginTop: 2 }}>
                {worker.id} · {worker.repo} · <span style={{ color: worker.profileColor }}>{worker.profileLabel}</span>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {worker.status === "asking" && <button className="btn primary" onClick={() => setModal("answer")}>answer question →</button>}
            <button className="btn" onClick={() => { setPaneDisabled(worker.id, !paused); flash(paused ? "Worker resumed" : "Worker paused"); }}>
              {paused ? "▶ resume" : "⏸ pause"}
            </button>
            <button className="btn ghost" onClick={() => setModal("steer")}>✎ steer</button>
            <button className="btn ghost" onClick={openSession}>▤ open session</button>
            <button className="btn ghost" onClick={() => setModal("profile")}>⛉ profile</button>
            <div style={{ flex: 1 }} />
            <button className="btn danger" onClick={() => setModal("stop")}>stop &amp; remove</button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "18px 24px" }}>
        {/* current / parked banner */}
        <div className="card" style={{ padding: "12px 16px", marginBottom: 14,
          borderColor: worker.note ? st.color : "var(--border-soft)",
          background: worker.note ? `color-mix(in oklch, ${st.color}, transparent 92%)` : "var(--bg-panel)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>current</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{worker.issue}</span>
            {worker.note && <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: st.color }}>· {worker.note}</span>}
          </div>
        </div>

        {/* KPIs — real where measured, explicit "—" otherwise */}
        <div className="statgrid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 14 }}>
          <StatCard k="issues owned" v={String(owned.length)} sub="assigned to this stream" tone="fg" />
          <StatCard k="profile" v={(profile?.name ?? worker.profileLabel).split(" ")[0]} sub={profile?.origin ?? "—"} tone="fg" />
          <StatCard k="status" v={st.label} sub="right now" tone={worker.status === "running" ? "accent" : worker.status === "blocked" ? "danger" : "fg"} />
          <StatCard k="repo" v={worker.repo.split("/")[1] ?? worker.repo} sub="worktree" tone="info" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            {/* Owned issues (real) */}
            <div className="card">
              <CardHead title="Owned issues" hint={`${owned.length} assigned to this stream`} />
              {owned.length === 0
                ? <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>No issues assigned to this stream.</div>
                : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                    {owned.map((ref, i) => (
                      <div key={ref} className="hrow" style={{ display: "grid", gridTemplateColumns: "1fr 70px", gap: 8, alignItems: "center", padding: "9px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
                        <span style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>{ref}</span>
                        <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 10, color: ref === worker.issue ? st.color : "var(--fg-dim)" }}>
                          ● {ref === worker.issue ? worker.status : "owned"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
            </div>
            <div className="card">
              <CardHead
                title="Done-time audit"
                hint={ended ? `ended ${ended.state} · ${ended.summary}` : "live snapshot of this worker's output"}
              />
              {!cwd ? (
                <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>No worktree bound to this pane.</div>
              ) : !doneAudit ? (
                <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>reading the worktree…</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* branch + PR + transcript */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontFamily: "var(--mono)", fontSize: 10.5 }}>
                    {doneAudit.branch && (
                      <span style={{ padding: "2px 8px", borderRadius: 99, border: "1px solid var(--border-soft)", color: "var(--fg-muted)" }}>⎇ {doneAudit.branch}</span>
                    )}
                    {doneAudit.pr ? (
                      <button
                        onClick={() => openUrl(doneAudit.pr!.url).catch(() => {})}
                        title="Open the pull request"
                        style={{ padding: "2px 9px", borderRadius: 99, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10.5,
                          color: doneAudit.pr.merged ? "var(--success)" : "var(--accent)",
                          background: `color-mix(in oklch, ${doneAudit.pr.merged ? "var(--success)" : "var(--accent)"}, transparent 88%)`,
                          border: `1px solid color-mix(in oklch, ${doneAudit.pr.merged ? "var(--success)" : "var(--accent)"}, transparent 65%)` }}
                      >
                        {doneAudit.pr.merged ? "✓ merged" : doneAudit.pr.state.toLowerCase()} · PR #{doneAudit.pr.number} ↗
                      </button>
                    ) : (
                      <span style={{ color: "var(--fg-dim)" }}>no PR yet</span>
                    )}
                    <span style={{ flex: 1 }} />
                    {doneAudit.transcriptPath && (
                      <button className="btn ghost" style={{ height: 22, fontSize: 10 }}
                        onClick={() => revealItemInDir(doneAudit.transcriptPath!).catch(() => {})}
                        title={doneAudit.transcriptPath}>transcript ↗</button>
                    )}
                  </div>
                  {/* changed files + commits */}
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
                    {doneAudit.changedFiles.length} uncommitted file{doneAudit.changedFiles.length === 1 ? "" : "s"} · {doneAudit.commits.length} recent commit{doneAudit.commits.length === 1 ? "" : "s"}
                  </div>
                  {doneAudit.commits.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                      {doneAudit.commits.slice(0, 8).map((c, i) => (
                        <div key={c.hash + i} style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: 8, alignItems: "center", padding: "7px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
                          <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--accent)" }}>{c.hash}</span>
                          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.subject}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="card">
              <CardHead title="Activity & audit" hint={`this worker · ${audit.length ? "tool attempts, newest first" : "from the bsc-audit log"}`} />
              {audit.length === 0
                ? <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                    No tool attempts logged yet for this worker. Gated panes append one line per tool use here.
                  </div>
                : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                    {audit.map((a, i) => (
                      <div key={i} className="hrow" style={{ display: "grid", gridTemplateColumns: "62px 1fr", gap: 8, alignItems: "center", padding: "8px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--accent)" }}>{a.toolName}</span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.target || "—"}</span>
                      </div>
                    ))}
                  </div>
                )}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            {/* Permissions (real, from the profile) */}
            <div className="card">
              <CardHead title="Permissions" hint={profile ? `${profile.name} · ${profile.origin}` : "no profile assigned"} />
              {profile ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 18px", marginBottom: 12 }}>
                    {[perms.slice(0, half), perms.slice(half)].flat().map((r) => (
                      <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 10.5 }}>
                        <span style={{ width: 7, height: 7, borderRadius: 99, background: TIER_COLOR[r.tier], flexShrink: 0 }} />
                        <span style={{ color: "var(--fg)", width: 42 }}>{r.key}</span>
                        <span style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ borderTop: "1px solid var(--border-soft)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>
                    <div><span style={{ color: "var(--fg-dim)" }}>paths allow </span>{profile.paths.allow.length ? profile.paths.allow.join(", ") : "—"}</div>
                    <div><span style={{ color: "var(--fg-dim)" }}>paths deny </span>{profile.paths.deny.length ? profile.paths.deny.join(", ") : "—"}</div>
                    <div><span style={{ color: "var(--fg-dim)" }}>network </span>{profile.net.allow.length ? profile.net.allow.join(", ") : "none"}</div>
                  </div>
                </>
              ) : (
                <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                  This worker runs under its role gate only — no least-privilege profile was assigned during planning.
                </div>
              )}
            </div>

            {/* Execution flow (real, from the flow) */}
            <div className="card">
              <CardHead title="Execution flow" hint="set during planning" />
              <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                {flowRows(flow).map((r, i) => (
                  <div key={r.key} style={{ display: "grid", gridTemplateColumns: "80px 110px 1fr", gap: 8, alignItems: "center", padding: "8px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{r.key}</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--accent)" }}>{r.value}</span>
                    <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>{r.desc}</span>
                  </div>
                ))}
              </div>
            </div>

            <Placeholder title="Tokens & spend" hint="not measured yet"
              body="Per-session token + cost accounting isn't wired up yet. Once it lands, this worker's token burn and spend appear here." />
          </div>
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)", zIndex: 220,
          background: "var(--bg-elev2)", border: "1px solid var(--border)", borderRadius: 8, padding: "9px 16px",
          fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)", boxShadow: "0 6px 24px rgba(0,0,0,0.4)" }}>{toast}</div>
      )}

      {(modal === "steer" || modal === "answer") && (
        <Modal title={modal === "answer" ? `Answer ${worker.name}` : `Steer ${worker.name}`} onClose={() => setModal(null)}
          footer={<>
            <button className="btn ghost" onClick={() => setModal(null)}>cancel</button>
            <button className="btn primary" onClick={() => send(modal)}>{modal === "answer" ? "send answer" : "send"}</button>
          </>}>
          {modal === "answer" && worker.note && (
            <div style={{ padding: "10px 12px", borderRadius: 8, background: `color-mix(in oklch, ${st.color}, transparent 90%)`, border: `1px solid color-mix(in oklch, ${st.color}, transparent 70%)`, marginBottom: 10, fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)" }}>
              {worker.note}
            </div>
          )}
          <div className="hint" style={{ marginBottom: 8 }}>Typed straight into this worker's running session.</div>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
            placeholder={modal === "answer" ? "your decision…" : "e.g. skip the migration; focus on the API contract"}
            style={{ width: "100%", minHeight: 84, resize: "vertical", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: 10, color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 12, outline: "none" }} />
        </Modal>
      )}
      {modal === "stop" && (
        <Modal title="Stop & remove worker" onClose={() => setModal(null)}
          footer={<>
            <button className="btn ghost" onClick={() => setModal(null)}>cancel</button>
            <button className="btn danger" onClick={stop}>stop &amp; remove</button>
          </>}>
          <div style={{ fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.6 }}>
            This stops <b style={{ color: "var(--fg)" }}>{worker.name}</b>'s session (disables its pane). Its worktree is
            preserved; re-enable the console to resume.
          </div>
        </Modal>
      )}
      {modal === "profile" && (
        <Modal title="Change profile" onClose={() => setModal(null)}>
          <div className="hint" style={{ marginBottom: 10 }}>Switch the least-privilege profile this worker runs under (applies on its next launch).</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflow: "auto" }}>
            {agentProfiles.map((p) => (
              <button key={p.id} onClick={() => { setPaneProfile(worker.id, p.id); setModal(null); flash(`Profile → ${p.name}`); }} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", textAlign: "left", cursor: "pointer",
                background: p.id === profileId ? "var(--bg-elev2)" : "var(--bg-elev)", color: "var(--fg)",
                border: "1px solid " + (p.id === profileId ? p.color : "var(--border-soft)"), borderRadius: 8,
              }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, flexShrink: 0 }} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, flex: 1 }}>{p.name}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>base {p.mode}</span>
                {p.id === profileId && <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: p.color }}>current</span>}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}
