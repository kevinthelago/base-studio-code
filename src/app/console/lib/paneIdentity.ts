// Pane identity (#1176). Pane state, the PTY, and crash recovery must key off a STABLE identity
// id, not the positional `t{tabIdx}p{paneIdx}` — positional keys get reused when a tab is closed
// and a new one lands on the index, so the new pane inherits persisted state (paneWasClaude, cwd,
// restoreRequested) and resumes a previous session.
//
// Identity is minted where a pane is created:
//   - MANUAL console ("+" button): an ephemeral id unique to the tab — `man:<tabId>:p<idx>`. The
//     tab already carries a stable uuid `id`, so a fresh manual tab can never collide into an old
//     one's state, and (because the id isn't a `project:…` identity) it is excluded from recovery.
//   - FLEET / TRIAGE panes: a meaningful id minted by project planning / triage launch
//     (`<projectKey>:<streamId>`, `<projectKey>:director`, `<projectKey>:<repo>:triage`), recorded
//     on the tab's `paneIds[]`. Recovery reconnects only the exact identity it belongs to.
//
// Stage 1 wires the MANUAL path; fleet/triage tabs (those with `kind`) keep the positional id until
// Stage 2 mints their `paneIds`.

export interface PaneIdentityTab {
  id?: string;
  /** Fleet ("build") / "triage" tabs are app-created; absence ⇒ a manually-created console. */
  kind?: "build" | "triage";
  /** Per-cell identity ids minted at fleet/triage launch (Stage 2). */
  paneIds?: string[];
}

/** The legacy positional id — still used for fleet/triage tabs until Stage 2. */
export function positionalPaneId(tabIdx: number, paneIdx: number): string {
  return `t${tabIdx}p${paneIdx}`;
}

/** A manual console pane's ephemeral, per-tab id. */
export function manualPaneId(tabId: string, paneIdx: number): string {
  return `man:${tabId}:p${paneIdx}`;
}

/** Fleet worker / director identity ids. */
export function fleetPaneId(projectKey: string, streamId: string): string {
  return `${projectKey}:${streamId}`;
}
export function directorPaneId(projectKey: string): string {
  return `${projectKey}:director`;
}

/** A per-repo triage pane's identity id. */
export function triagePaneId(projectKey: string, repo: string): string {
  return `${projectKey}:${repo}:triage`;
}

/** Whether an id is a manual console pane — manual panes are never auto-recovered (#1176). */
export function isManualPaneId(id: string): boolean {
  return id.startsWith("man:");
}

/**
 * Whether an id is the dedicated PLANNER pane — `planning_<key>` (Planning.tsx), the intentional
 * exception to the `<key>:<stream>` identity scheme. A planning session is re-entered via the
 * Projects page, not restored from the crash-recovery banner, so it's excluded from recovery (#1579).
 */
export function isPlanningPaneId(id: string): boolean {
  return id.startsWith("planning_");
}

/**
 * Resolve a pane's identity id from its tab + grid position. A minted `paneIds[idx]` (fleet/triage,
 * Stage 2) wins; otherwise a fleet/triage tab keeps the positional id (Stage 1), a manual tab with a
 * stable `id` gets a `man:` id, and an id-less legacy tab falls back to positional.
 */
export function paneIdFor(tab: PaneIdentityTab | undefined, tabIdx: number, paneIdx: number): string {
  const minted = tab?.paneIds?.[paneIdx];
  if (minted) return minted;
  if (tab?.kind) return positionalPaneId(tabIdx, paneIdx);
  if (tab?.id) return manualPaneId(tab.id, paneIdx);
  return positionalPaneId(tabIdx, paneIdx);
}

/**
 * Whether `paneId` is one of the cells `tab` (at grid index `tabIdx`) owns — the inverse of
 * `paneIdFor`. A minted id matches when it is in the tab's `paneIds[]`; a `man:<tabId>:…` id
 * matches when the tab's stable `id` matches; a legacy positional `t<idx>p…` id matches when
 * the tab index matches. Director / worker / triage identity ids only ever belong via `paneIds`.
 *
 * This is the identity-aware replacement for parsing a positional key out of a pane id: a status
 * rollup or a stale-status clear must work for manual (`man:`) and minted fleet/triage ids too,
 * not just the legacy positional shape (#1176).
 */
export function paneBelongsToTab(paneId: string, tab: PaneIdentityTab, tabIdx: number): boolean {
  if (tab.paneIds?.includes(paneId)) return true;
  const parsed = parsePaneIdentity(paneId);
  if (!parsed) return false;
  if (parsed.kind === "manual") return !!tab.id && parsed.tabId === tab.id;
  if (parsed.kind === "positional") return parsed.tabIdx === tabIdx;
  return false;
}

/**
 * Find the tab that owns `paneId` (and its index), or null. Scans by identity (`paneBelongsToTab`)
 * so a manual (`man:…`) or minted fleet/triage id resolves to its real tab — the positional
 * `parsePaneKey` could only ever resolve legacy `t<idx>p…` ids, which silently dropped the rollup
 * for every identity-keyed pane (#1176).
 */
export function findPaneOwnerTab<T extends PaneIdentityTab>(
  tabs: readonly T[],
  paneId: string,
): { tab: T; tabIdx: number } | null {
  for (let i = 0; i < tabs.length; i++) {
    if (paneBelongsToTab(paneId, tabs[i], i)) return { tab: tabs[i], tabIdx: i };
  }
  return null;
}

// ── Parsing identity ids back into meaning (#1266) ──────────────────────────────
//
// The id grammar is self-describing, so a session can be recovered from its NAME alone —
// the key to scanning durable, store-independent sources (the pty ledger, the worktree tree)
// and rebuilding the session topology when the persisted store has lost it.

/** The shape a pane identity id encodes. `positional` is the legacy `t{idx}p{idx}` form. */
export type PaneIdentityKind = "director" | "worker" | "triage" | "manual" | "positional";

export interface ParsedPaneIdentity {
  kind: PaneIdentityKind;
  /** The id as given. */
  raw: string;
  /** Present for director / worker / triage. */
  projectKey?: string;
  /** Present for a worker — its stream id. */
  streamId?: string;
  /** Present for a triage pane — the repo (`owner/name`). */
  repo?: string;
  /** Present for a manual console — its owning tab's stable id. */
  tabId?: string;
  /** Present for manual / positional — the grid cell index. */
  paneIdx?: number;
  /** Present for positional — the tab index. */
  tabIdx?: number;
}

/**
 * Parse a pane identity id back into its structured meaning — the inverse of the minting
 * helpers above (#1266). The grammar:
 *
 *   man:<tabId>:p<idx>          → manual console (ephemeral; never auto-recovered)
 *   t<idx>p<idx>                → legacy positional id
 *   <projectKey>:<repo>:triage  → per-repo triage pane
 *   <projectKey>:director       → a project's director
 *   <projectKey>:<streamId>     → a fleet worker
 *
 * Project keys are sanitized to `[A-Za-z0-9-]` (no colons), so colons are purely structural
 * separators and repo full names carry `/`, never `:`. Returns `null` for an unrecognized
 * shape. Known ambiguity: a worker whose stream id were literally `director` (or a 2-part
 * `<key>:triage`) would classify as director/worker respectively — real planner stream ids
 * never collide with those reserved tails.
 */
export function parsePaneIdentity(id: string): ParsedPaneIdentity | null {
  // Manual: man:<tabId>:p<idx>. The tabId may contain hyphens but no colon; the :p<n> tail is fixed.
  const manual = /^man:(.+):p(\d+)$/.exec(id);
  if (manual) {
    return { kind: "manual", raw: id, tabId: manual[1], paneIdx: Number(manual[2]) };
  }
  // Legacy positional: t<idx>p<idx>.
  const positional = /^t(\d+)p(\d+)$/.exec(id);
  if (positional) {
    return { kind: "positional", raw: id, tabIdx: Number(positional[1]), paneIdx: Number(positional[2]) };
  }
  const parts = id.split(":");
  // Triage: <key>:<repo>:triage — a "triage" tail with the repo in between (repo has no colon).
  if (parts.length >= 3 && parts[parts.length - 1] === "triage" && parts[0]) {
    return { kind: "triage", raw: id, projectKey: parts[0], repo: parts.slice(1, -1).join(":") };
  }
  // Director: <key>:director.
  if (parts.length === 2 && parts[1] === "director" && parts[0]) {
    return { kind: "director", raw: id, projectKey: parts[0] };
  }
  // Worker: <key>:<streamId> — both parts non-empty.
  if (parts.length >= 2 && parts[0] && parts.slice(1).join(":")) {
    return { kind: "worker", raw: id, projectKey: parts[0], streamId: parts.slice(1).join(":") };
  }
  return null;
}

/**
 * The identity to provision a per-agent sandbox Linux USER for (#1994), or `null` when this pane must
 * keep the sealed distro's shared default user.
 *
 * Per-agent filesystem isolation: a sandboxed FLEET pane — a `<projectKey>:<streamId>` worker or the
 * `<projectKey>:director`, running INSIDE the sealed WSL2 distro (`distro` set) — runs as its OWN
 * non-root Linux user with a locked-down (`700`) home, so co-located agents can't read or tamper with
 * its files even via raw Bash. Every other pane (manual / triage / planner / positional) and every
 * non-sandboxed pane (no `distro`) keep the distro's shared default user.
 *
 * The DIRECTOR gets its own user too (#4260): the issue's requirement is that worker↔director be
 * isolated by the OS rather than by the `bsc-scope` write hook alone. It costs the director nothing —
 * its cwd is the project hub, which lives in the group-shared base (`SHARED_BASE`) that every agent
 * user reaches, not in any one home.
 *
 * Returns the pane id itself — the agent's STABLE identity (`fleetPaneId` / `directorPaneId`) — so a
 * relaunch re-derives (via the Rust `agent_user_name`) and reuses the SAME Linux user + home. Pure (no
 * invoke) so the "which pane gets a user" decision is unit-testable; the caller provisions it with
 * `ensure_sandbox_user` and threads the returned username to `pty_create`'s `wslUser`.
 */
export function sandboxUserIdentity(paneId: string, distro: string | undefined): string | null {
  if (!distro) return null;
  const kind = parsePaneIdentity(paneId)?.kind;
  return kind === "worker" || kind === "director" ? paneId : null;
}

/**
 * The Rust command + args that resolve a pane's on-disk dir from its identity (#1819 hardening) — for
 * a claude pane whose configured cwd came back EMPTY (the async `bscBaseDir` mirror wasn't loaded when
 * the pane's cwd was set, so `projectRepoCwd`/`projectHubCwd` returned ""). The launch can then recover
 * an authoritative absolute path from the backend instead of running permission-less.
 *
 * `triage` → its repo clone dir (`repo_dir_path`); `director` → the project hub (`project_dir_path`).
 * Returns `null` for an id whose dir can't be derived from the id alone — manual/positional panes, or a
 * `worker` (its cwd is a worktree keyed by the agent id, which `ensure_worktree` already supplies). Pure
 * (no invoke) so it's unit-testable; the caller runs the returned command.
 */
export function paneCwdRecovery(
  paneId: string,
): { cmd: "repo_dir_path" | "project_dir_path"; args: Record<string, string> } | null {
  const id = parsePaneIdentity(paneId);
  if (!id?.projectKey) return null;
  if (id.kind === "triage" && id.repo) {
    return { cmd: "repo_dir_path", args: { projectKey: id.projectKey, repo: id.repo } };
  }
  if (id.kind === "director") {
    return { cmd: "project_dir_path", args: { projectKey: id.projectKey } };
  }
  return null;
}
