// Agents — Activity-tab display rows (#257 / #1643).
//
// Turns the raw `bsc-audit` log lines into the computed rows the Activity table
// renders: each row carries the resolving console name, the pane's profile, the
// display kind/target, and the derived allow/ask/block decision (per the pane's
// resolved policy — profile ∪ role, the same rules the launch gate applies). Plus
// the toolbar filter + decision counts. Pure — split out of AgentsScreen so the
// transforms are React-free + unit-testable.

import { roleCapability, roleWriteRules, type SessionRole } from "@/shared/lib/session/sessionRoles";
import { resolveProfileSettings } from "./profileEnforcement";
import { parseAuditLog, toRow, decideAudit, type AuditDecision, type AuditKind, type ResolvedGate } from "./auditLog";
import type { AgentProfile, ConsoleSession } from "./agentProfiles";

/** The Activity toolbar's decision filter (`all` shows everything). */
export type DecFilter = "all" | "allow" | "ask" | "block";

/** A computed audit row for the Activity table. */
export interface AuditDisplayRow {
  ts: string;
  console: string;
  pane: string;
  profileId: string;
  kind: AuditKind;
  target: string;
  decision: AuditDecision;
}

/** The state the row derivation reads to resolve each record's console + gate. */
export interface AuditRowContext {
  consoles: Pick<ConsoleSession, "id" | "name">[];
  profiles: AgentProfile[];
  paneProfiles: Record<string, string>;
  paneRoles: Record<string, SessionRole>;
}

/**
 * Build the display rows from raw audit log lines. Each record's decision is derived
 * from the pane's resolved gate (profile ∪ role) — the same rules the launch gate
 * applies — and its console name is resolved from the pane id's tab index.
 */
export function buildAuditRows(lines: string[], ctx: AuditRowContext): AuditDisplayRow[] {
  const records = parseAuditLog(lines.join("\n"));
  return records.map((rec): AuditDisplayRow => {
    const profileId = ctx.paneProfiles[rec.pane] ?? "";
    const profile = ctx.profiles.find((p) => p.id === profileId);
    const role = ctx.paneRoles[rec.pane];
    const roleCap = role ? roleCapability(role) : undefined;
    const prof = profile ? resolveProfileSettings(profile) : null;
    const roleW = roleCap ? roleWriteRules(roleCap) : { allow: [], deny: [] };
    const gate: ResolvedGate = {
      allowedCommands: prof?.allowedCommands ?? [],
      allowToolRules: [...(prof?.allowToolRules ?? []), ...roleW.allow],
      denyToolRules: [...(prof?.denyToolRules ?? []), ...roleW.deny],
    };
    const r = toRow(rec);
    const ti = Number(/^t(\d+)p/.exec(rec.pane)?.[1] ?? "-1");
    return {
      ts: rec.ts,
      console: ctx.consoles.find((c) => c.id === `t${ti}`)?.name ?? "—",
      pane: rec.pane,
      profileId: profileId || "—",
      kind: r.kind,
      target: r.target,
      decision: decideAudit(rec, gate, roleCap),
    };
  });
}

/** Filter rows by the toolbar's decision + console-name selectors (`all` = no filter). */
export function filterAuditRows(rows: AuditDisplayRow[], decision: DecFilter, console: string): AuditDisplayRow[] {
  return rows.filter((r) => {
    if (decision !== "all" && r.decision !== decision) return false;
    if (console !== "all" && r.console !== console) return false;
    return true;
  });
}

/** Tally the rows by decision for the Activity summary cards + filter chips. */
export function auditDecisionCounts(rows: AuditDisplayRow[]): { allow: number; ask: number; block: number } {
  let allow = 0, ask = 0, block = 0;
  for (const r of rows) {
    if (r.decision === "allow") allow++;
    else if (r.decision === "ask") ask++;
    else block++;
  }
  return { allow, ask, block };
}

/** Format an ISO timestamp as a local 24h time, passing through unparseable input. */
export function fmtAuditTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleTimeString("en-US", { hour12: false });
}
