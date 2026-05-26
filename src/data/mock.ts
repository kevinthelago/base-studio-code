// Domain types — shared across store, components, and screens.
// All sample data has been removed; see git history if needed.

export interface TextBlock     { kind: "text";     text: string }
export interface ThinkingBlock { kind: "thinking"; text: string; dur: string; collapsed?: boolean }
export interface ToolBlock     { kind: "tool";     tool: string; args: string; ok?: boolean; summary?: string; preview?: string }
type Block = TextBlock | ThinkingBlock | ToolBlock;
type AssistantTurn = { role: "assistant"; blocks: Block[] };
type UserTurn      = { role: "user";      text: string };
export type Turn = AssistantTurn | UserTurn;

export interface FileRow {
  name: string; path: string;
  depth?: number; dir?: boolean; open?: boolean;
  status?: "M" | "A" | "??" | "D";
}

export interface Branch {
  n: string; cur?: boolean;
  ahead?: number; behind?: number;
  age: string; merged?: boolean; stale?: boolean;
}

export interface DiffLine { sign: " " | "+" | "-"; text: string }
export interface DiffHunk { file: string; add: number; del: number; sample: DiffLine[] }

export interface Commit { s: string; m: string; who: string; t: string; head?: boolean; merge?: boolean }

export interface KbTag   { name: string; n: number }
export interface KbBlock { id: string; title: string; tags: string[]; updated: string; lines: number; content?: string }

export interface Schedule {
  id: string; name: string; on: boolean;
  when: string; target: string;
  action: "command" | "knowledge";
  detail: string; lastRun: string; nextRun: string;
}

export interface Command {
  id: string; name: string; cmd: string;
  kind?: "claude"; used: number; tags: string[];
}

// ── Projects ──────────────────────────────────────────────────────────────────
// Project list, board, and roadmap data now comes from the GitHub API.
// Only the Planning session types and sample data remain here.

export type PlanSectionState = "confirmed" | "drafted" | "asking" | "pending";
export interface PlanSectionItem { label: string; tag?: string; note?: string }
export interface PlanSection {
  k: string; title: string; state: PlanSectionState;
  body?: string; items?: PlanSectionItem[]; pendingQ?: string;
}

export type PlanBlock =
  | { kind: "text";     text: string }
  | { kind: "thinking"; text: string; dur: string }
  | { kind: "tool";     tool: string; args: string; ok: boolean; summary: string };

export type PlanTurnData =
  | { role: "assistant"; blocks: PlanBlock[] }
  | { role: "user";      text: string };


export const PLAN_TURNS: PlanTurnData[] = [
  { role: "assistant", blocks: [
    { kind: "text", text: "Got it — settlement webhooks v2. Let's scope it.\n\nFirst: **what's breaking with the current polling setup?** Is it latency for customers, infra cost, or both?" },
  ]},
  { role: "user", text: "mostly latency. p95 is 9–12s and merchants are noticing. cost is fine for now." },
  { role: "assistant", blocks: [
    { kind: "tool", tool: "kb.search", args: "settlement, polling, sla", ok: true, summary: "3 blocks pinned" },
    { kind: "text", text: "Found prior decisions — pinning **blk_2199 (SQLite over LMDB)** and **blk_71fe (Tunnel framing v2)** for context.\n\nWhat's your target p95? And who's the audience for the notification — the merchant dashboard, an email/SMS hook, or both?" },
  ]},
  { role: "user", text: "sub-second for the dashboard. email/SMS can stay async; we don't need that to be fast." },
  { role: "assistant", blocks: [
    { kind: "thinking", dur: "2s", text: "Two surfaces with different SLAs — that splits the design cleanly. The dashboard path is the hard part." },
    { kind: "text", text: "Logged **Goal 1: dashboard p95 ≤ 1s**. Next: **who pays the webhook?** Our own settlement worker, Stripe events, or a mix?" },
  ]},
];

export const PLAN_SECTIONS: PlanSection[] = [
  { k: "pitch",       title: "Pitch",       state: "confirmed",
    body: "Move settlement events off polling and onto webhooks for sub-second customer notifications." },
  { k: "problem",     title: "Problem",     state: "confirmed",
    body: "Polling-based settlement updates land in the merchant dashboard at p95 9–12s; merchants notice." },
  { k: "users",       title: "Audiences",   state: "confirmed",
    items: [
      { label: "merchant dashboard", note: "sub-second SLA · the hard target" },
      { label: "email / SMS hooks",  note: "can stay async · no SLA change" },
    ]},
  { k: "goals",       title: "Goals",       state: "confirmed",
    items: [
      { label: "dashboard p95 ≤ 1s",         tag: "primary" },
      { label: "no regression on email/SMS", tag: "guardrail" },
    ]},
  { k: "non-goals",   title: "Non-goals",   state: "drafted",
    items: [
      { label: "replacing the stripe-events fanout pipeline" },
      { label: "merchant-side webhook delivery (out of scope this quarter)" },
    ]},
  { k: "constraints", title: "Constraints", state: "asking",
    pendingQ: "who pays the webhook? are these stripe-issued, our own worker, or both?",
    items: [
      { label: "deadline · this quarter", note: "merchant op-review on July 14" },
      { label: "team · 2 engineers",      note: "lina + alex" },
    ]},
  { k: "approach",    title: "Approach · phases", state: "pending" },
  { k: "risks",       title: "Risks",              state: "pending" },
  { k: "open",        title: "Open questions",     state: "pending", items: [] },
];
