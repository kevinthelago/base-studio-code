// Interpretation + report caching for the host-environment diagnostics (#446/#447).
//
// The backend `preflight` probe (`src-tauri/src/lib.rs`) runs the prerequisite
// checks in the same login shell + env an agent's subshells use and returns one
// `PrereqStatus` per external dependency (Git Bash, `claude`, `git`, `gh`, plus
// `gh` auth), each with presence/version/path and an install hint. This module
// turns that raw list into a single user-facing verdict — overall severity, a
// headline, and a per-prerequisite explanation of what specifically breaks when
// it is missing (a missing Git Bash or `claude` gets its own message, not a
// generic failure) — and caches the last report so the Diagnostics view can
// render immediately on open. The console-shell selection + its persistence
// lives in `shellConfig.ts` (split out in #1711).
//
// Free of React/Tauri imports so it can be unit-tested and shared. Mirrors
// `githubReadiness.ts` (the GitHub-readiness probe interpreter).

/**
 * One prerequisite's detected state. Field names match the backend `PrereqStatus`
 * (`src-tauri/src/lib.rs`) so the probe result deserializes straight into this.
 */
export interface PrereqStatus {
  /** Display name: "Git Bash", "claude", "git", "gh", or "gh auth". */
  name: string;
  /** Whether the tool was located (and, for "gh auth", authenticated). */
  found: boolean;
  /** First line of `<tool> --version`, when found. */
  version: string | null;
  /** Resolved on-disk path, when found. */
  path: string | null;
  /** Actionable install/fix hint from the backend — empty when `found`. */
  hint: string;
}

/** How badly a missing prerequisite degrades the app. */
export type PrereqSeverity = "critical" | "warning";

/**
 * A prerequisite plus the interpreted consequence of its current state. `ok`
 * mirrors `found`; when not ok, `severity` says how bad it is and `consequence`
 * explains, in user terms, what stops working until it is fixed.
 */
export interface PrereqVerdict extends PrereqStatus {
  ok: boolean;
  /** Only meaningful when `!ok`. */
  severity: PrereqSeverity;
  /** What breaks while this is missing — empty when `ok`. */
  consequence: string;
}

/** The whole-host verdict the Diagnostics view renders. */
export interface DiagnosticsReport {
  prereqs: PrereqVerdict[];
  /** True only when every prerequisite is satisfied. */
  allOk: boolean;
  /** Worst severity among the missing prerequisites; null when `allOk`. */
  worst: PrereqSeverity | null;
  /** One-line summary — "All prerequisites satisfied." or a count of what's missing. */
  headline: string;
}

/**
 * What stops working when a given prerequisite is missing, and how severe that is.
 * Critical prerequisites block agents from running at all; warnings degrade a
 * specific capability (PR creation). Names not listed default to a critical,
 * generic consequence so a newly-probed tool is never silently treated as benign.
 */
function consequenceFor(name: string): { severity: PrereqSeverity; consequence: string } {
  switch (name) {
    case "Git Bash":
      return {
        severity: "critical",
        consequence:
          "Console sessions can't launch — Git Bash is the shell that runs agents on Windows. Install Git for Windows, then relaunch.",
      };
    case "claude":
      return {
        severity: "critical",
        consequence:
          "Agents can't run — the `claude` CLI is what every console session executes. Install it, then relaunch.",
      };
    case "git":
      return {
        severity: "critical",
        consequence:
          "Repository operations fail — agents can't clone, commit, or create worktrees without `git`.",
      };
    case "gh":
      return {
        severity: "warning",
        consequence:
          "Agents can't open pull requests — install the GitHub CLI (`gh`) to enable PR creation and review.",
      };
    case "gh auth":
      return {
        severity: "warning",
        consequence:
          "`gh` is installed but not authenticated — set `GH_TOKEN` or run `gh auth login` so agents can push and open PRs.",
      };
    default:
      return {
        severity: "critical",
        consequence: "This prerequisite is required for agents to run.",
      };
  }
}

/**
 * Pure: turn the backend probe's prerequisite list into the full host verdict.
 * Each entry gains an `ok`/`severity`/`consequence`; the report's `allOk`,
 * `worst`, and `headline` summarize the set. A single missing critical
 * prerequisite makes `worst` critical even if warnings also exist.
 */
export function interpretDiagnostics(prereqs: PrereqStatus[]): DiagnosticsReport {
  const verdicts: PrereqVerdict[] = prereqs.map((p) => {
    if (p.found) {
      return { ...p, ok: true, severity: "warning", consequence: "" };
    }
    const { severity, consequence } = consequenceFor(p.name);
    return { ...p, ok: false, severity, consequence };
  });

  const missing = verdicts.filter((v) => !v.ok);
  const allOk = missing.length === 0;
  const worst: PrereqSeverity | null = allOk
    ? null
    : missing.some((m) => m.severity === "critical")
      ? "critical"
      : "warning";

  let headline: string;
  if (allOk) {
    headline = "All prerequisites satisfied.";
  } else {
    const names = missing.map((m) => m.name).join(", ");
    const noun = missing.length === 1 ? "prerequisite" : "prerequisites";
    headline = `${missing.length} ${noun} need attention: ${names}.`;
  }

  return { prereqs: verdicts, allOk, worst, headline };
}

// ── Diagnostics report cache (#447) ─────────────────────────────────────────

const REPORT_KEY = "bsc.diagnostics.report.v1";

/** A persisted diagnostics report plus when it was taken (epoch ms). */
export interface StoredReport {
  report: DiagnosticsReport;
  takenAt: number;
}

/** Cache the latest report so the view can render instantly on open. Best-effort. */
export function saveReport(report: DiagnosticsReport, takenAt: number): void {
  try {
    globalThis.localStorage?.setItem(REPORT_KEY, JSON.stringify({ report, takenAt }));
  } catch {
    /* storage unavailable — the view re-probes on open anyway */
  }
}

/** Read the cached report, or null when absent/unparseable. */
export function loadReport(): StoredReport | null {
  try {
    const raw = globalThis.localStorage?.getItem(REPORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredReport;
    if (!parsed || !parsed.report || !Array.isArray(parsed.report.prereqs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── PTY-session readiness bridge (#564) ─────────────────────────────────────
// Adapts the DiagnosticsReport produced by interpretDiagnostics() into the
// simpler blocking/warning interface the pane's SessionFailure/SessionReadinessBanner
// components need. The backend `preflight` command returns Vec<PrereqStatus>; call
// interpretDiagnostics() first, then sessionVerdictFromReport().

export type CheckSeverity = "critical" | "warning" | "ok";

export interface ReadinessCheck {
  /** Stable id for the check — used as a React key and for filtering. */
  id: string;
  severity: CheckSeverity;
  /** User-facing one-liner. Empty string when severity is "ok". */
  message: string;
  /** Official download/install URL extracted from the backend hint, when present. */
  installUrl?: string;
}

export interface SessionVerdict {
  /** All checks, including passing ones. */
  checks: ReadinessCheck[];
  /** Worst severity across all checks. */
  worstSeverity: CheckSeverity;
  /** True when any critical check failed — the session cannot run until resolved. */
  blocking: boolean;
  /** Checks that did not pass (severity !== "ok"). */
  failed: ReadinessCheck[];
}

function toReadinessCheck(v: PrereqVerdict): ReadinessCheck {
  if (v.ok) return { id: v.name, severity: "ok", message: "" };
  const urlMatch = v.hint.match(/https?:\/\/\S+/);
  return {
    id: v.name,
    severity: v.severity,
    message: v.consequence,
    installUrl: urlMatch?.[0],
  };
}

/**
 * Convert a `DiagnosticsReport` into the pane-level `SessionVerdict` used by
 * `SessionFailure` and `SessionReadinessBanner`. Call after `interpretDiagnostics`.
 */
export function sessionVerdictFromReport(report: DiagnosticsReport): SessionVerdict {
  const checks = report.prereqs.map(toReadinessCheck);
  const failed = checks.filter((c) => c.severity !== "ok");
  const blocking = report.worst === "critical";
  const worstSeverity: CheckSeverity = report.worst ?? "ok";
  return { checks, worstSeverity, blocking, failed };
}
