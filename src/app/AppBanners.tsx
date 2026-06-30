import { useState, useEffect, useCallback } from "react";
import { LifeBuoy, RotateCcw, Trash2, ShieldAlert } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import {
  discoverSessions, reconcileSessions, type RecoverableSession,
} from "@/app/console/lib/sessionRecovery";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";
import { Banner } from "@/shared/ui/feedback/Banner";
import { useSandboxReadiness } from "@/shared/hooks/useSandboxReadiness";

// ════════════════════════════════════════════════════════════════════════════════════════════
// App banners — the full-width status strips pinned at the top of the app shell. Each is a small
// adapter: it subscribes to the store for its trigger + data, gates its own visibility, and renders
// a <Banner variant="bar"> with the right actions. <AppBanners> mounts the set (App renders it once).
// ════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Crash-recovery banner (#1041). After an UNCLEAN shutdown — a crash / kill / power loss / force-quit
 * detected by the session-lock marker surviving the previous run (`was_unclean_shutdown`) — offer a
 * one-click restore of the Claude sessions that were running, each resuming its prior conversation
 * (`claude --continue`, staggered). A CLEAN quit never shows this; sessions stay dormant.
 *
 * Hidden when silent auto-resume already handled the crash (`autoResumeClaude` on) or there's nothing
 * to restore. Dismissable; one-shot per app run.
 */
function CrashRecoveryBanner() {
  const uncleanShutdown = useAppStore((s) => s.uncleanShutdown);
  const autoResumeClaude = useAppStore((s) => s.autoResumeClaude);
  const paneWasClaude = useAppStore((s) => s.paneWasClaude);
  const restoreSessionsFromCrash = useAppStore((s) => s.restoreSessionsFromCrash);
  const [hidden, setHidden] = useState(false);

  const count = Object.keys(paneWasClaude).filter((p) => paneWasClaude[p]).length;
  // Silent auto-resume already relaunches on a crash when the user opted in — no banner needed then.
  if (hidden || !uncleanShutdown || autoResumeClaude || count === 0) return null;

  return (
    <Banner
      variant="bar"
      tone="accent"
      onDismiss={() => setHidden(true)}
      right={
        <button
          className="btn primary"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          onClick={() => { restoreSessionsFromCrash(); setHidden(true); }}
        >
          <RotateCcw size={13} /> Restore {count}
        </button>
      }
    >
      Your last session ended unexpectedly —{" "}
      <b>restore {count} session{count === 1 ? "" : "s"}</b> from where {count === 1 ? "it" : "they"} left off?
    </Banner>
  );
}

/**
 * Session recovery surface (#1266 Stage 4). On boot the backend scans durable, store-independent
 * sources (the pty-ledger, worktrees, plan.db fleet) for sessions the persisted store has lost or
 * never had; this reconciles them against the OPEN tabs and presents the gap for the user to act on.
 *
 * Read-only by default — NOTHING auto-rehydrates. Per project the user can **Restore** (reopen the
 * fleet/triage tab + resume), and per session **Discard** (reap a live orphaned shell) or **Ignore**
 * (dismiss). Manual scratch shells + orphans of a deleted project are reap-only (never restored,
 * #1176/#1279). Distinct from the crash banner (#1041), which only resumes panes the store remembers.
 */
export function SessionRecoveryBanner() {
  const fleetStartProject = useAppStore((s) => s.fleetStartProject);
  const triageStartProject = useAppStore((s) => s.triageStartProject);

  const [recoverable, setRecoverable] = useState<RecoverableSession[]>([]);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // One scan per app run, after mount. Reconcile against the tabs snapshot at scan time; the user
  // acts explicitly, so we don't need to re-run as tabs change.
  useEffect(() => {
    let cancelled = false;
    void discoverSessions()
      .then((found) => { if (!cancelled) setRecoverable(reconcileSessions(found, useAppStore.getState().tabs)); })
      .catch(() => { /* command absent (tests / old binary) — nothing to recover */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drop = useCallback((paneIds: Set<string>) => {
    setRecoverable((rs) => rs.filter((s) => !paneIds.has(s.paneId)));
  }, []);

  const restoreProject = useCallback(async (projectKey: string, sessions: RecoverableSession[]) => {
    const build = sessions.filter((s) => s.kind === "director" || s.kind === "worker");
    const triage = sessions.filter((s) => s.kind === "triage");
    if (build.length) {
      const fleet = await invoke<FleetPlan | null>("plan_get_fleet", { projectKey }).catch(() => null);
      if (fleet) fleetStartProject(projectKey, fleet, projectKey);
    }
    if (triage.length) {
      const repos = [...new Set(triage.map((s) => s.repo).filter((r): r is string => !!r))];
      if (repos.length) {
        // Resolve each repo's absolute clone dir from Rust (#1819) so the triage panes launch with
        // a real cwd even when the async `bscBaseDir` mirror is still empty at crash-recovery
        // startup — an empty cwd makes TerminalView skip the settings.json writer, leaving the
        // session with no role gate / shell allowlist (it then prompts for everything). Per-repo
        // and fail-soft: a failed resolve omits that repo's entry, falling back to the mirror.
        const clonePaths: Record<string, string> = {};
        await Promise.all(repos.map(async (repo) => {
          const dir = await safeInvoke<string>("repo_dir_path", { projectKey, repo }, "");
          if (dir) clonePaths[repo] = dir;
        }));
        triageStartProject(projectKey, repos, projectKey, undefined, clonePaths);
      }
    }
    drop(new Set(sessions.map((s) => s.paneId)));
  }, [fleetStartProject, triageStartProject, drop]);

  const discard = useCallback(async (s: RecoverableSession) => {
    await invoke("reap_session", { paneId: s.paneId }).catch(() => {});
    drop(new Set([s.paneId]));
  }, [drop]);

  if (dismissed || recoverable.length === 0) return null;

  // Group by project; reap-only sessions with no project key collect under a "Manual / unrestorable" group.
  const groups = new Map<string, RecoverableSession[]>();
  for (const s of recoverable) {
    const key = s.projectKey || (s.kind === "manual" ? " manual" : " orphan");
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }

  return (
    <>
      <Banner
        variant="bar"
        tone="info"
        lead={<LifeBuoy size={14} style={{ color: "var(--info)", flexShrink: 0 }} />}
        right={<button className="btn" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Review"}</button>}
        onDismiss={() => setDismissed(true)}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <b>{recoverable.length} session{recoverable.length === 1 ? "" : "s"}</b> found on disk that {recoverable.length === 1 ? "isn't" : "aren't"} open — restore or discard?
        </span>
      </Banner>

      {open && (
        <div style={{ background: "color-mix(in oklch, var(--info), transparent 88%)", borderBottom: "1px solid var(--border-soft)", fontFamily: "var(--sans)", color: "var(--fg)", padding: "4px 14px 12px", display: "grid", gap: 12, maxHeight: 320, overflowY: "auto" }}>
          {[...groups.entries()].map(([key, sessions]) => {
            const manual = key === " manual", orphan = key === " orphan";
            const restorable = sessions.filter((s) => !s.reapOnly);
            const label = manual ? "Manual scratch shells" : orphan ? "Orphaned (deleted project)" : key;
            return (
              <div key={key} style={{ border: "1px solid var(--border-soft)", borderRadius: 6, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--bg-panel)" }}>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                  <span className="hint" style={{ fontSize: 10.5 }}>{sessions.length}</span>
                  {restorable.length > 0 && (
                    <button className="btn primary" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, padding: "3px 8px" }}
                      onClick={() => restoreProject(key, restorable)}>
                      <RotateCcw size={12} /> Restore {restorable.length}
                    </button>
                  )}
                </div>
                {sessions.map((s) => (
                  <div key={s.paneId} style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 8, alignItems: "center", padding: "6px 10px", borderTop: "1px solid var(--border-soft)" }}>
                    <span style={{ minWidth: 0, display: "grid", gap: 1 }}>
                      <span className="mono" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.paneId}</span>
                      <span className="hint" style={{ fontSize: 10 }}>{s.kind} · {s.status}{s.sources.length ? ` · ${s.sources.join("+")}` : ""}</span>
                    </span>
                    {s.reapOnly ? <span className="hint" style={{ fontSize: 10 }}>reap-only</span> : <span />}
                    <button className="btn ghost" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => drop(new Set([s.paneId]))} title="Ignore for now">Ignore</button>
                    <button className="btn ghost" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "3px 8px", color: "var(--danger)" }}
                      onClick={() => discard(s)} title={s.livePid ? `Kill pid ${s.livePid} + forget` : "Forget"}>
                      <Trash2 size={12} /> Discard
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * Warden quarantine banner (#1102). When the warden hard-pauses a worker that drifted off its
 * plan (PTY killed — possible prompt injection / hijack), surface it loudly here so the user can't
 * miss it (it's also pushed to a paired phone). One row per quarantined pane with its trip summary;
 * dismissing a row clears the quarantine flag (the user's explicit acknowledgement). The worker's
 * PTY was already stopped, so this is acknowledge-and-relaunch-when-ready, not auto-resume.
 */
function QuarantineBanner() {
  const quarantinedPanes = useAppStore((s) => s.quarantinedPanes);
  const clearQuarantine = useAppStore((s) => s.clearQuarantine);

  const entries = Object.entries(quarantinedPanes);
  if (entries.length === 0) return null;

  return (
    <>
      {entries.map(([paneId, info]) => (
        <Banner
          key={paneId}
          variant="bar"
          tone="danger"
          lead={<ShieldAlert size={15} style={{ color: "var(--red, #d4554f)", flexShrink: 0 }} />}
          onDismiss={() => clearQuarantine(paneId)}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <b>Worker quarantined</b> — stream <b>{info.streamId}</b> ({paneId}) was paused: {info.summary}.
            Review before relaunching.
          </span>
        </Banner>
      ))}
    </>
  );
}

/**
 * First-run sandbox-setup nudge (#1916). Under the deny-list posture (auto-run), the OS sandbox is the
 * layer that actually confines Bash — but on a fresh machine it isn't installed yet. When the posture
 * is on and the probe (#1982) says the sandbox isn't ready, surface a one-time, dismissible nudge that
 * does the install **right here**: the step's action button (Install bubblewrap on Linux / Install
 * sandbox on Windows) runs `provision_sandbox` with a live progress bar, via the shared
 * `useSandboxReadiness` hook (same engine as the Settings posture card). Dismiss is persisted
 * (`sandboxNudgeDismissed`) so it's first-run, not every launch; it auto-hides once the sandbox is
 * ready or the user switches to the allow-list posture. A step the app can't auto-install (e.g. WSL
 * not present) shows the manual next step from the probe's `detail` instead of a dead button.
 */
export function SandboxSetupBanner() {
  const bypassPermissions = useAppStore((s) => s.bypassPermissions);
  const dismissed = useAppStore((s) => s.sandboxNudgeDismissed);
  const dismiss = useAppStore((s) => s.dismissSandboxNudge);
  const { sandbox, installing, installMsg, install } = useSandboxReadiness();

  if (dismissed || !bypassPermissions || !sandbox || sandbox.ready) return null;

  const label = sandbox.needsWsl ? "Install sandbox" : "Install bubblewrap";
  return (
    <Banner
      variant="bar"
      tone="warn"
      lead={<ShieldAlert size={14} style={{ color: "var(--warn)", flexShrink: 0 }} />}
      right={
        sandbox.autoInstallable ? (
          <button className="btn primary" onClick={install} disabled={installing}>
            {installing ? "Installing…" : label}
          </button>
        ) : undefined
      }
      onDismiss={dismiss}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <span>
          <b>Agent sandbox not set up</b> — {installing ? "installing…" : (installMsg ?? sandbox.detail)}
        </span>
        {installing && (
          <div aria-hidden style={{ height: 3, borderRadius: 2, background: "color-mix(in oklch, var(--warn), transparent 75%)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: "30%", background: "var(--warn)", animation: "scan 1.1s linear infinite" }} />
          </div>
        )}
      </div>
    </Banner>
  );
}

/** The set of full-width banners pinned at the top of the app shell, mounted once by App. */
export function AppBanners() {
  return (
    <>
      <CrashRecoveryBanner />
      <SessionRecoveryBanner />
      <QuarantineBanner />
      <SandboxSetupBanner />
    </>
  );
}
