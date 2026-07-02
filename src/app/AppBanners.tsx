import { useState, useEffect, useCallback } from "react";
import { LifeBuoy, RotateCcw, Trash2, ShieldAlert } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { bscJson } from "@/shared/lib/core/bsc";
import { useAppStore } from "@/store";
import {
  discoverSessions, reconcileSessions, type RecoverableSession,
} from "@/app/console/lib/sessionRecovery";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";
import { Banner } from "@/shared/ui/feedback/Banner";
import { Button } from "@/shared/ui/controls/Button";
import { useSandboxReadiness } from "@/shared/hooks/useSandboxReadiness";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

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
        <Button
          variant="primary"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          onClick={() => { restoreSessionsFromCrash(); setHidden(true); }}
        >
          <RotateCcw size={13} /> Restore {count}
        </Button>
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
      const fleet = await bscJson<FleetPlan | null>(projectKey, ["plan", "fleet", "get", "--full", "--json"], null);
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
        right={<Button onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Review"}</Button>}
        onDismiss={() => setDismissed(true)}
      >
        <Box as="span" style={{ flex: 1, minWidth: 0 }}>
          <b>{recoverable.length} session{recoverable.length === 1 ? "" : "s"}</b> found on disk that {recoverable.length === 1 ? "isn't" : "aren't"} open — restore or discard?
        </Box>
      </Banner>

      {open && (
        <Box className="banner-drawer" style={{ gap: 12 }}>
          {[...groups.entries()].map(([key, sessions]) => {
            const manual = key === " manual", orphan = key === " orphan";
            const restorable = sessions.filter((s) => !s.reapOnly);
            const label = manual ? "Manual scratch shells" : orphan ? "Orphaned (deleted project)" : key;
            return (
              <Box key={key} border="soft" radius={6} style={{ overflow: "hidden" }}>
                <Row gap={8} style={{ padding: "6px 10px", background: "var(--bg-panel)" }}>
                  <Box as="span" className="mono" style={{ fontSize: 11, color: "var(--fg)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</Box>
                  <Text className="hint" size={10.5}>{sessions.length}</Text>
                  {restorable.length > 0 && (
                    <Button variant="primary" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, padding: "3px 8px" }}
                      onClick={() => restoreProject(key, restorable)}>
                      <RotateCcw size={12} /> Restore {restorable.length}
                    </Button>
                  )}
                </Row>
                {sessions.map((s) => (
                  <Grid key={s.paneId} cols="1fr auto auto auto" gap={8} align="center" style={{ padding: "6px 10px", borderTop: "1px solid var(--border-soft)" }}>
                    <Box as="span" style={{ minWidth: 0, display: "grid", gap: 1 }}>
                      <Box as="span" className="mono" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.paneId}</Box>
                      <Text className="hint" size={10}>{s.kind} · {s.status}{s.sources.length ? ` · ${s.sources.join("+")}` : ""}</Text>
                    </Box>
                    {s.reapOnly ? <Text className="hint" size={10}>reap-only</Text> : <Box as="span" />}
                    <Button variant="ghost" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => drop(new Set([s.paneId]))} title="Ignore for now">Ignore</Button>
                    <Button variant="ghost" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "3px 8px", color: "var(--danger)" }}
                      onClick={() => discard(s)} title={s.livePid ? `Kill pid ${s.livePid} + forget` : "Forget"}>
                      <Trash2 size={12} /> Discard
                    </Button>
                  </Grid>
                ))}
              </Box>
            );
          })}
        </Box>
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
  const acknowledgeQuarantine = useAppStore((s) => s.acknowledgeQuarantine);
  const [open, setOpen] = useState(false);

  // Hide acknowledged quarantines — dismissing acknowledges (the worker stays paused + the warden
  // keeps skipping it), so a still-present out-of-lane edit can't re-trip and re-show the banner.
  const entries = Object.entries(quarantinedPanes).filter(([, info]) => !info.acknowledged);
  if (entries.length === 0) return null;
  const n = entries.length;

  // ONE summary banner for the whole set — the per-pane detail (and per-worker Acknowledge) lives in
  // an expandable drawer, so N quarantined workers read as a single alert instead of N stacked bars.
  return (
    <>
      <Banner
        variant="bar"
        tone="danger"
        role="alert"
        lead={<ShieldAlert size={15} style={{ color: "var(--red, #d4554f)", flexShrink: 0 }} />}
        right={
          <Box as="span" style={{ display: "inline-flex", gap: 6 }}>
            <Button onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Review"}</Button>
            {n > 1 && (
              <Button variant="ghost" onClick={() => entries.forEach(([p]) => acknowledgeQuarantine(p))} title="Acknowledge all">
                Ack all
              </Button>
            )}
          </Box>
        }
      >
        <Box as="span" style={{ flex: 1, minWidth: 0 }}>
          <b>{n} worker{n === 1 ? "" : "s"} quarantined</b> — {n === 1 ? "a stream was" : `${n} streams were`} paused off-plan.
          Review before relaunching.
        </Box>
      </Banner>

      {open && (
        <Box className="banner-drawer">
          {entries.map(([paneId, info]) => (
            <Grid key={paneId} cols="1fr auto" gap={8} align="start" style={{ padding: "7px 9px", borderRadius: 5, background: "color-mix(in oklch, var(--danger), var(--bg-panel) 90%)" }}>
              <Box as="span" style={{ minWidth: 0, display: "grid", gap: 2 }}>
                <Box as="span" className="mono" style={{ fontSize: 11, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>

                  {info.streamId} · {paneId}
                </Box>
                <Text className="hint" size={10.5}>{info.summary}</Text>
              </Box>
              <Button variant="ghost" style={{ fontSize: 11, padding: "3px 8px", whiteSpace: "nowrap" }} onClick={() => acknowledgeQuarantine(paneId)}>
                Acknowledge
              </Button>
            </Grid>
          ))}
        </Box>
      )}
    </>
  );
}

/**
 * First-run sandbox-setup nudge (#1916). Under the deny-list posture (auto-run), the OS sandbox is the
 * layer that actually confines Bash — but on a fresh machine it isn't installed yet. When the posture
 * is on and the probe (#1982) says the sandbox isn't ready, surface a one-time, dismissible nudge that
 * does the install **right here**: the step's action button (Install bubblewrap on Linux / Install
 * sandbox on Windows) runs `provision_sandbox` with a live progress bar, via the shared
 * `useSandboxReadiness` hook (same engine as the Settings posture card). It auto-hides once the
 * sandbox is ready or the user switches to the allow-list posture. A step the app can't auto-install
 * (e.g. WSL not present) shows the manual next step from the probe's `detail` instead of a dead button.
 *
 * It SELF-LIMITS by counting DISMISSALS: each ✕ press bumps the persisted `sandboxNudgeDismissCount`,
 * and once that reaches `SANDBOX_NUDGE_MAX_DISMISSALS` the nudge stays hidden across launches. Counting
 * dismissals (not shows) keeps the nudge visible on every launch until the user actually acknowledges
 * it, rather than vanishing after one render they may have missed. (Settings still surfaces the same
 * install action permanently, so the user can always set it up there.)
 */
const SANDBOX_NUDGE_MAX_DISMISSALS = 1;

export function SandboxSetupBanner() {
  const bypassPermissions = useAppStore((s) => s.bypassPermissions);
  const dismissCount = useAppStore((s) => s.sandboxNudgeDismissCount);
  const dismiss = useAppStore((s) => s.dismissSandboxNudge);
  const { sandbox, installing, installMsg, install } = useSandboxReadiness();

  if (dismissCount >= SANDBOX_NUDGE_MAX_DISMISSALS || !bypassPermissions || !sandbox || sandbox.ready) return null;

  const label = sandbox.needsWsl ? "Install sandbox" : "Install bubblewrap";
  return (
    <Banner
      variant="bar"
      tone="warn"
      lead={<ShieldAlert size={14} style={{ color: "var(--warn)", flexShrink: 0 }} />}
      right={
        sandbox.autoInstallable ? (
          <Button variant="primary" onClick={install} disabled={installing}>
            {installing ? "Installing…" : label}
          </Button>
        ) : undefined
      }
      onDismiss={dismiss}
    >
      <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
        <Text>
          <b>Agent sandbox not set up</b> — {installing ? "installing…" : (installMsg ?? sandbox.detail)}
        </Text>
        {installing && (
          <Box aria-hidden bg="color-mix(in oklch, var(--warn), transparent 75%)" radius={2} style={{ height: 3, overflow: "hidden" }}>
            <Box bg="var(--warn)" style={{ height: "100%", width: "30%", animation: "scan 1.1s linear infinite" }} />
          </Box>
        )}
      </Stack>
    </Banner>
  );
}

/**
 * The app-shell alerts, floated in a FIXED top-right overlay (`.app-banner-stack`) so they never push
 * the shell down or cram the UI. Each adapter gates its own visibility (an empty stack is inert —
 * `pointer-events: none`). Multi-item alerts (quarantine, session recovery) collapse to ONE summary
 * banner with a "Review" drawer rather than one bar per item. Mounted once by App.
 */
export function AppBanners() {
  return (
    <Box className="app-banner-stack">
      <CrashRecoveryBanner />
      <SessionRecoveryBanner />
      <QuarantineBanner />
      <SandboxSetupBanner />
    </Box>
  );
}
