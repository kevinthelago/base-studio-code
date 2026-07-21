// Agents — audit-log model + decision derivation (#257).
//
// A PreToolUse hook on gated panes appends one TAB-separated line per tool attempt to
// a per-app log (see the `bsc-audit` helper + `read_audit_log`). A flat, redacted line
// — `ts \t pane \t toolName \t target` — is used deliberately: it never writes full
// tool inputs (which could contain file contents / secrets) and is trivially safe to
// emit from shell. This module parses those lines and derives the allow/ask/block
// decision for each, per the pane's resolved policy (profile ∪ role), reusing the same
// rules the launch gate applies.
//
// The derived decision is the app's *policy view*, not a capture of Claude Code's
// internal permission outcome — they agree because the settings are generated from
// these same rules, but treat it as advisory. Pure + unit-testable.

import { checkCommand, matchGlob, type RoleCapability } from "@/shared/lib/session/sessionRoles";

export type AuditDecision = "allow" | "ask" | "block";
export type AuditKind = "cmd" | "tool" | "net";

/** One tool attempt (a parsed `bsc-audit` line). `target` is the command (Bash), file
 *  path (edit tools), or url/query (web) — redacted/short, never full input. */
export interface AuditRecord {
  ts: string; // ISO-8601
  pane: string; // paneId
  toolName: string;
  target: string;
}

export interface AuditRow extends AuditRecord {
  kind: AuditKind;
}

/** The resolved allow/deny rules for a pane (profile ∪ role) — same shape the launch
 *  gate feeds to `ensure_session_settings`. */
export interface ResolvedGate {
  allowedCommands: string[];
  allowToolRules: string[];
  denyToolRules: string[];
}

/** Parse the TSV audit log into records, skipping malformed lines. */
export function parseAuditLog(text: string): AuditRecord[] {
  const out: AuditRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [ts, pane, toolName, ...rest] = line.split("\t");
    if (ts && pane && toolName) {
      out.push({ ts, pane, toolName, target: rest.join("\t") });
    }
  }
  return out;
}

const NET_TOOLS = new Set(["WebFetch", "WebSearch"]);
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Add the display `kind` to a record. */
export function toRow(r: AuditRecord): AuditRow {
  const kind: AuditKind = r.toolName === "Bash" ? "cmd" : NET_TOOLS.has(r.toolName) ? "net" : "tool";
  return { ...r, kind };
}

/** Parse a `Tool(glob)` rule into its parts, or null for a bare tool rule. */
function parseScoped(rule: string): { tool: string; glob: string } | null {
  const m = /^([A-Za-z]+)\((.+)\)$/.exec(rule);
  return m ? { tool: m[1], glob: m[2] } : null;
}

/**
 * Derive the decision for one record against the pane's resolved gate (+ optional role
 * capability for `git`/`gh` command checks). Deny wins; an unlisted capability is `ask`
 * (Claude Code prompts); `Bash` is broadly allowed unless the role gate blocks it.
 */
export function decideAudit(r: AuditRecord, gate: ResolvedGate, roleCap?: RoleCapability): AuditDecision {
  if (r.toolName === "Bash") {
    if (roleCap && !checkCommand(roleCap, r.target).allowed) return "block";
    return "allow"; // Bash is broadly allowed; command control is the allowlist + role gate
  }

  const file = FILE_TOOLS.has(r.toolName) ? r.target : "";

  // Deny wins: a bare tool deny, or a path-scoped deny whose glob matches the file.
  if (gate.denyToolRules.includes(r.toolName)) return "block";
  if (file) {
    for (const rule of gate.denyToolRules) {
      const p = parseScoped(rule);
      if (p && p.tool === r.toolName && matchGlob(p.glob, file)) return "block";
    }
  }
  // Allow: a bare tool allow, or a path-scoped allow whose glob matches.
  if (gate.allowToolRules.includes(r.toolName)) return "allow";
  if (file) {
    for (const rule of gate.allowToolRules) {
      const p = parseScoped(rule);
      if (p && p.tool === r.toolName && matchGlob(p.glob, file)) return "allow";
    }
  }
  return "ask";
}
