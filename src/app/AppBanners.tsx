import { useState, useEffect, useCallback, useMemo } from "react";
import { LifeBuoy, RotateCcw, Trash2, ShieldAlert, PartyPopper, GitBranch } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { bscJson } from "@/shared/lib/core/bsc";
import { usePoll } from "@/shared/hooks/usePoll";
import { projectComplete } from "@/shared/lib/fleet/streamCompletion";
import type { PlanIssue } from "@/features/planner/issues/planIssues";
import { useAppStore } from "@/store";
import { checkStoreParity, explainDrift, type StoreDrift } from "@/app/runtime/storeParity";
import {
  discoverSessions, reconcileSessions, type RecoverableSession,
} from "@/app/console/lib/sessionRecovery";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";
import { Banner } from "@/shared/ui/feedback/Banner";
import { Button } from "@/shared/ui/controls/Button";
import { Chip } from "@/shared/ui/data/Chip";
import { kitDispatchPrompt, type KitChange } from "@/features/designs";
import { injectPrompt } from "@/shared/lib/fleet/paneInject";
import { directorPaneId } from "@/app/console/lib/paneIdentity";
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
  const navigate = useAppStore((s) => s.navigate);

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
    // Ensure the hub is materialized on disk before relaunching (#2997 C): recovered fleet/triage cwds
    // are the hub dir or worktrees beneath it. A prior fleet run almost always materialized it already
    // (so this is a no-op), but a draft recovered before its first launch needs the ephemeral planning
    // workspace promoted first. Best-effort — the recovery has no error surface, and the launch paths
    // below already fall back to nearest-existing-ancestor cwds.
    await safeInvoke("materialize_hub", { projectKey }, "");
    const build = sessions.filter((s) => s.kind === "director" || s.kind === "worker");
    const triage = sessions.filter((s) => s.kind === "triage");
    if (build.length) {
      const fleet = await bscJson<FleetPlan | null>(projectKey, ["plan", "fleet", "get", "--full", "--json"], null);
      if (fleet) {
        fleetStartProject(projectKey, fleet, projectKey);
        // Land the user on their restored agents (#2445): drill Glance into the project, on the Network
        // tab (#3598 — else the drill shows nothing). Overrides fleetStartProject's console navigation —
        // after a recovery the fleet-level Glance view is the surface that shows what just came back (and
        // works even with GitHub disconnected). One `navigate` sets drill + page + workspace atomically
        // so none can be forgotten (#3602).
        navigate({ workspace: "glance", page: "network", drill: projectKey });
      }
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
  }, [fleetStartProject, triageStartProject, navigate, drop]);

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
 * Application-complete banner (#2619). When the active project's FLEET has finished — it has planned
 * issues and EVERY one is done (`complete`/`verified`, {@link projectComplete}) — announce it, so the
 * user knows the build landed and can do a verify/preview run. Polls the active project's plan.db
 * issues only while it HAS a fleet and hasn't been acknowledged this session (so it never nags a
 * still-building or already-seen project). The CTA opens the finished project — the entry point the
 * verify preview + reviewer loop (#…) will grow into. Acknowledging (✕ or the CTA) hides it for the
 * session, keyed per project so a different project can still announce its own completion.
 */
const COMPLETE_POLL_MS = 20000;

function ProjectCompleteBanner() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const activeProjectName = useAppStore((s) => s.activeProjectName);
  const planFleet = useAppStore((s) => s.planFleet);
  const navigate = useAppStore((s) => s.navigate);
  const [acked, setAcked] = useState<Set<string>>(() => new Set());
  const [completeKey, setCompleteKey] = useState<string | null>(null);

  const key = activeProjectId ?? "";
  // Only a project that was actually BUILT (has a fleet) and hasn't been acknowledged this session.
  const enabled = !!key && (planFleet[key]?.streams.length ?? 0) > 0 && !acked.has(key);

  usePoll(async (isCancelled) => {
    if (!enabled) return;
    const issues = await bscJson<PlanIssue[]>(key, ["plan", "list", "--full", "--json"], []);
    if (isCancelled()) return;
    setCompleteKey(projectComplete(issues) ? key : null);
  }, COMPLETE_POLL_MS, [enabled, key]);

  const ack = useCallback((k: string) => setAcked((s) => new Set(s).add(k)), []);

  if (!enabled || completeKey !== key) return null;
  const name = activeProjectName || key;

  return (
    <Banner
      variant="bar"
      tone="accent"
      role="status"
      lead={<PartyPopper size={15} style={{ color: "var(--accent)", flexShrink: 0 }} />}
      onDismiss={() => ack(key)}
      right={
        <Button
          variant="primary"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          onClick={() => { navigate({ workspace: "glance", page: "network", drill: key }); ack(key); }}
        >
          Preview &amp; review
        </Button>
      }
    >
      <Box as="span" style={{ flex: 1, minWidth: 0 }}>
        <b>{name} is complete</b> — every planned issue landed. Preview and review your app.
      </Box>
    </Banner>
  );
}

/**
 * The app-shell alerts, floated in a FIXED top-right overlay (`.app-banner-stack`) so they never push
 * the shell down or cram the UI. Each adapter gates its own visibility (an empty stack is inert —
 * `pointer-events: none`). Multi-item alerts (quarantine, session recovery) collapse to ONE summary
 * banner with a "Review" drawer rather than one bar per item. Mounted once by App.
 */
/** Where the bsc-on-PATH dismissal persists (a nudge, not a nag). */
const PATH_DISMISS_KEY = "bsc.pathExpose.dismissed";

/**
 * bsc-on-PATH banner (#2734). Inside the app, sessions exec the bundled `bsc` by an absolute `$BSC_BIN`
 * path (#2001) — no PATH. So a bare `bsc` in the user's OWN terminal won't resolve. When detection
 * (`path_expose_status`) reports it isn't on PATH, this offers a one-click, CONSENTED add: the banner
 * names the exact dir first, the click IS the consent, and `path_expose_configure` reports back exactly
 * what changed + how to undo it. Dismissal persists; once configured, detection hides it next launch.
 */
export function PathExposeBanner() {
  const [status, setStatus] = useState<{ configured: boolean; binDir: string | null } | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(PATH_DISMISS_KEY) === "1"; } catch { return false; }
  });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ target: string; undo: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    // Fall back to "configured" on any detection failure — never nag when we can't actually tell.
    void safeInvoke<{ configured: boolean; binDir: string | null }>(
      "path_expose_status", undefined, { configured: true, binDir: null },
    ).then((s) => { if (!cancelled) setStatus(s); });
    return () => { cancelled = true; };
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(PATH_DISMISS_KEY, "1"); } catch { /* private mode — dismiss for this run */ }
    setDismissed(true);
  };

  const configure = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await invoke<{ changed: boolean; target: string; undo: string }>("path_expose_configure");
      setDone({ target: r.target, undo: r.undo });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Nothing to offer: still probing, already on PATH, no bundled bsc, or dismissed.
  if (dismissed || !status || status.configured || !status.binDir) return null;

  if (done) {
    return (
      <Banner
        variant="bar"
        tone="success"
        onDismiss={dismiss}
        lead={<Text weight={600} style={{ whiteSpace: "nowrap" }}>✓ bsc on PATH</Text>}
      >
        <Text>
          Added to {done.target}. Reopen your terminal to run <Text as="span" mono>bsc</Text>. To undo: {done.undo}
        </Text>
      </Banner>
    );
  }

  return (
    <Banner
      variant="bar"
      tone="info"
      onDismiss={dismiss}
      lead={<Text weight={600} style={{ whiteSpace: "nowrap" }}>bsc CLI</Text>}
      right={
        <Button variant="primary" onClick={configure} disabled={busy}>
          {busy ? "Configuring…" : "Add to PATH"}
        </Button>
      }
    >
      <Stack gap={2} style={{ flex: 1 }}>
        <Text>
          Run <Text as="span" mono>bsc</Text> from your own terminal — add{" "}
          <Text as="span" mono>{status.binDir}</Text> to your PATH.
        </Text>
        {error && <Text size="xxs" style={{ color: "var(--danger)" }}>{error}</Text>}
      </Stack>
    </Banner>
  );
}

const KIT_CLASS_TONE: Record<KitChange["class"], string> = {
  breaking: "var(--danger)",
  additive: "var(--accent)",
  fix: "var(--success)",
};

/**
 * Kit-change approval banner (#2944). After the designer session makes kit modifications, the store
 * fans them out to consumer projects (`kitDispatches`). By default (auto-apply OFF — a Planner setting)
 * they're GATED here: one summary banner + a Review drawer listing each change, its propagated
 * consumers, and an **Approve** button that releases it to the drain (routing it into each live
 * consumer's director). Approving marks the change approved so it leaves this gate immediately;
 * dismissing drops it. Hidden entirely when auto-apply is ON (changes flow without a gate).
 */
function KitChangesBanner() {
  const dispatches = useAppStore((s) => s.kitDispatches);
  const autoApply = useAppStore((s) => s.autoApplyKitChanges);
  const paneDirectorDrive = useAppStore((s) => s.paneDirectorDrive);
  const dismissKitChange = useAppStore((s) => s.dismissKitChange);
  const [open, setOpen] = useState(false);

  // Group the pending dispatches by change → its consumer projects.
  const groups = useMemo(() => {
    const m = new Map<string, { change: KitChange; projects: string[] }>();
    for (const d of dispatches) {
      const g = m.get(d.change.id);
      if (g) g.projects.push(d.projectKey);
      else m.set(d.change.id, { change: d.change, projects: [d.projectKey] });
    }
    return [...m.values()];
  }, [dispatches]);

  if (autoApply || groups.length === 0) return null;
  const n = groups.length;
  // Approve = deliver the change to any LIVE consumer (into its director, like the drain), then REMOVE
  // all of the change's dispatches (#2951) — gone immediately and for good. Dismiss just drops it.
  const approve = (g: { change: KitChange; projects: string[] }) => {
    for (const pk of g.projects) {
      if (paneDirectorDrive?.[directorPaneId(pk)]) void injectPrompt(directorPaneId(pk), kitDispatchPrompt(g.change));
    }
    dismissKitChange(g.change.id);
  };
  const dismissChange = (g: { change: KitChange; projects: string[] }) => dismissKitChange(g.change.id);

  return (
    <>
      <Banner
        variant="bar"
        tone="accent"
        role="status"
        lead={<GitBranch size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />}
        right={<Button onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Review"}</Button>}
      >
        <Box as="span" style={{ flex: 1, minWidth: 0 }}>
          <b>{n} kit change{n === 1 ? "" : "s"}</b> from the designer {n === 1 ? "is" : "are"} ready to apply — review &amp; approve.
        </Box>
      </Banner>

      {open && (
        <Box className="banner-drawer">
          {groups.map((g) => (
            <Box key={g.change.id} border="soft" radius={6} style={{ overflow: "hidden" }}>
              <Row gap={8} style={{ padding: "7px 10px", flexWrap: "wrap", alignItems: "center" }}>
                <Chip color={KIT_CLASS_TONE[g.change.class]}>{g.change.class}</Chip>
                <Text weight={600} size={12.5}>{g.change.component}</Text>
                <Text size={12} tone="muted" style={{ flex: 1, minWidth: 100 }}>— {g.change.summary}</Text>
                <Button variant="primary" style={{ fontSize: 11, padding: "3px 10px" }} onClick={() => approve(g)}>Approve</Button>
                <Button variant="ghost" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => dismissChange(g)}>Dismiss</Button>
              </Row>
              {g.change.migration && (
                <Text size={11} tone="muted" as="div" style={{ padding: "0 10px 6px" }}>Migration: {g.change.migration}</Text>
              )}
              <Box style={{ padding: "6px 10px", borderTop: "1px solid var(--border-soft)", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <Text size={10.5} tone="dim">propagates to</Text>
                {g.projects.length === 0 ? (
                  <Text size={10.5} tone="dim">— no consumer projects yet</Text>
                ) : g.projects.map((pk) => (
                  <Text key={pk} mono size={10.5} tone="muted" style={{ background: "var(--bg-panel)", borderRadius: 4, padding: "1px 6px" }}>{pk}</Text>
                ))}
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </>
  );
}


/**
 * Interrupted-loop banner (#3961). A `bsc loop` in flight when the app DIES is never reconciled: the
 * store keeps it `open`, and a participant's `bsc loop watch` blocks on a turn that will never come.
 * Every other `ended_by` describes a loop that reached a DECISION (a sentinel fired, a ceiling was hit,
 * someone called stop); a crash reaches none of them.
 *
 * Gated on the SAME unclean-shutdown signal as the session restore above — after a clean quit an open
 * loop is legitimately dormant, not stranded. The boot probe only COUNTS (`reap --dry-run`); closing
 * them is the user's call, and records `ended_by=interrupted` rather than `stop` so the row stays
 * truthful about why it ended. Dismissing writes nothing — they reappear after the next crash.
 */
function InterruptedLoopBanner() {
  const loops = useAppStore((s) => s.interruptedLoops);
  const reap = useAppStore((s) => s.reapInterruptedLoops);
  const dismiss = useAppStore((s) => s.dismissInterruptedLoops);

  if (loops.length === 0) return null;
  const n = loops.length;
  const named = loops.slice(0, 2).map((l) => `${l.a}↔${l.b}`).join(", ");

  return (
    <Banner
      variant="bar"
      tone="warn"
      onDismiss={dismiss}
      right={
        <Button variant="primary" onClick={() => { void reap(); }}>
          Close {n}
        </Button>
      }
    >
      {n} loop{n === 1 ? "" : "s"} ({named}{n > 2 ? `, +${n - 2}` : ""}) {n === 1 ? "was" : "were"}{" "}
      <b>interrupted</b> when the app stopped unexpectedly — {n === 1 ? "it is" : "they are"} still open,
      so anything waiting on a turn will wait forever.
    </Banner>
  );
}

/**
 * Seed-drift banner (#4216) — the reader `seedNotices` never had.
 *
 * `reconcileSeed` has always computed divergence verdicts (`updated-upstream`, `orphaned`,
 * `reset-to-seed`, and now `unstamped`) and the store has always collected them. Nothing rendered them:
 * every reference to `seedNotices` lived inside the designs slice itself, so the mechanism computed the
 * right answer and dropped it on the floor. That is why 44 app records drifted from their seeds unnoticed
 * while every guard we had — which reads the SEED, not the store copy the app renders — stayed green.
 *
 * Deliberately REPORT-ONLY. It offers no "fix all": the drift runs both directions (some store copies are
 * far smaller than their seed, some far larger), so which side is right is a per-record judgement. A
 * one-click bulk resolve would be the more dangerous bug.
 */
/** Store<->file parity (#4246) — the ONLY guard on the copy the app actually mounts.
 *
 *  Every other check compares the SEED (`graphParity.test.ts` globs `@data/components/app/**`), while
 *  `GraphComponent` renders `useAppStore(s => s.components).srcText`. Those coincide only for a record in
 *  the reconcile path, and six page records carry no `builtin` — so `reconcileSeed` returns early and
 *  `seedAuthoritative` (#3723), written to stop exactly this, is never reached. `skillspage` renders 9137
 *  characters fewer than its seed; `automationspage` 4591 more.
 *
 *  It lives in the SHELL, not in the designs feature, for the layering reason and the honest one: this is
 *  a fact about what the app mounts. A feature cannot import `app/runtime/shadowPages`, and the check has
 *  no business being a store field that every consumer must remember to read.
 *
 *  DEV-only inside `checkStoreParity` — a packaged build has no source tree to compare against, so there
 *  is nothing it could truthfully say. Cheap: text in, outline out; it compiles nothing and loads no
 *  feature chunks (that is shadow mode's binding walk, which is why THAT one is on demand). */
function StoreParityBanner() {
  const components = useAppStore((s) => s.components);
  const [drift, setDrift] = useState<StoreDrift[]>([]);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    // Re-checks whenever the store's components change — which is once per hydrate, and again after a
    // designer edit. That is the right cadence: an edit is precisely when a record can start drifting.
    void checkStoreParity(components).then((d) => { if (live) setDrift(d); });
    return () => { live = false; };
  }, [components]);

  if (dismissed || drift.length === 0) return null;
  const n = drift.length;

  return (
    <>
      <Banner
        variant="bar"
        tone="warn"
        lead={<GitBranch size={14} />}
        right={
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Review"}
          </Button>
        }
        onDismiss={() => setDismissed(true)}
      >
        {n} rendered module{n === 1 ? "" : "s"} do{n === 1 ? "es" : ""} not match {n === 1 ? "its" : "their"} source
        file — the app is mounting the store copy. No seed-side guard can see this.
      </Banner>
      {open && (
        <Box className="app-banner-detail">
          <Stack gap={4}>
            {drift.map((d) => (
              <Text key={`${d.pageId}:${d.recordId}`} size={11} tone="dim" mono>
                {explainDrift(d)}
              </Text>
            ))}
          </Stack>
        </Box>
      )}
    </>
  );
}

function SeedDriftBanner() {
  const notices = useAppStore((s) => s.seedNotices);
  const dismissSeedNotice = useAppStore((s) => s.dismissSeedNotice);
  const restampUnstamped = useAppStore((s) => s.restampUnstamped);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const repair = useCallback(async () => {
    setBusy(true);
    try {
      const { stamped, deferred } = await restampUnstamped();
      // Name the deferrals rather than reporting a bare count: they are the records the repair
      // deliberately would not touch (pages, where the seed would win, #3723), and a "re-stamped 38" that
      // silently omitted 6 would read as a complete repair.
      setResult(
        deferred > 0
          ? `Re-stamped ${stamped}. ${deferred} page${deferred === 1 ? "" : "s"} left alone — the seed wins for pages, so stamping would replace what renders.`
          : `Re-stamped ${stamped}.`,
      );
    } finally {
      setBusy(false);
    }
  }, [restampUnstamped]);

  // `unstamped` is the state nothing was watching for; the rest are pre-existing verdicts that were
  // equally invisible. Group so the count reads as "what kind of trouble", not just "how many".
  const byKind = useMemo(() => {
    const m = new Map<string, typeof notices>();
    for (const n of notices) m.set(n.kind, [...(m.get(n.kind) ?? []), n]);
    return [...m.entries()];
  }, [notices]);

  if (notices.length === 0) return null;
  const n = notices.length;

  return (
    <>
      <Banner
        variant="bar"
        tone="warn"
        lead={<GitBranch size={14} />}
        right={
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Review"}
          </Button>
        }
        // Dismissing acknowledges the whole set for this run; the notices are recomputed on the next
        // hydrate, so this hides a known state rather than resolving it.
        onDismiss={() => notices.forEach((it) => dismissSeedNotice(it.type, it.id))}
      >
        {n} record{n === 1 ? "" : "s"} differ{n === 1 ? "s" : ""} from the packaged seed — the app renders
        the store copy. Review which side is right; this is not resolved automatically.
      </Banner>
      {open && (
        <Box className="app-banner-detail">
          <Stack gap={8}>
            {byKind.map(([kind, items]) => (
              <Stack key={kind} gap={4}>
                <Text size={11} tone="dim" mono>
                  {kind} · {items.length}
                </Text>
                <Row gap={4} wrap>
                  {items.map((it) => (
                    <Chip key={`${it.type}:${it.id}`}>{it.name || it.id}</Chip>
                  ))}
                </Row>
                {kind === "unstamped" && (
                  // The ONE verdict with a safe automatic repair (#4207). The others each need a human to
                  // pick a side; this one does not, because it does not adjudicate content at all — it
                  // restores the record's membership in the reconcile and leaves the content alone.
                  <Row gap={8} align="center">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={repair}>
                      {busy ? "Re-stamping…" : `Re-stamp ${items.length}`}
                    </Button>
                    <Text size={11} tone="dim">
                      {result ??
                        "Marks these as packaged built-ins so seed updates reach them again. Content is not changed."}
                    </Text>
                  </Row>
                )}
              </Stack>
            ))}
          </Stack>
        </Box>
      )}
    </>
  );
}

export function AppBanners() {
  return (
    <Box className="app-banner-stack">
      <KitChangesBanner />
      <SeedDriftBanner />
      <StoreParityBanner />
      <CrashRecoveryBanner />
      <InterruptedLoopBanner />
      <SessionRecoveryBanner />
      <QuarantineBanner />
      <SandboxSetupBanner />
      <ProjectCompleteBanner />
      <PathExposeBanner />
    </Box>
  );
}
