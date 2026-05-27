// Typed mock data for the Automations screen, transcribed from
// design/Automations.html. Sample data only — the real scheduler/runtime is
// future work (#142). Named with an `Auto*` prefix to avoid clashing with the
// store's simpler `Schedule`/`Command` types in src/data/mock.ts.

export type RunStatus = "ok" | "warn" | "fail";

export interface AutoWhen {
  kind: string;   // "simple" | "cron" | "event"
  every: string;  // "day" | "weekday" | "week" | "month" | "hour"
  at: string;
  tz: string;
}

export interface AutoTarget {
  console: string;
  pane: string;
}

export interface AutoAction {
  kind: "command" | "knowledge";
  detail: string;
  block?: string;
}

export interface AutoSchedule {
  id: string;
  name: string;
  on: boolean;
  when: AutoWhen;
  cron: string;
  target: AutoTarget;
  action: AutoAction;
  lastRun: string;
  nextRun: string;
}

export interface AutoRun {
  when: string;
  status: RunStatus;
  dur: string;
  out: string;
}

export interface AutoHistoryRow {
  when: string;
  sid: string;
  name: string;
  target: string;
  status: RunStatus;
  dur: string;
  trigger: string;
  out: string;
}

export const AUTO_SCHEDULES: AutoSchedule[] = [
  {
    id: "S-01", name: "Nightly review digest", on: true,
    when: { kind: "simple", every: "day", at: "02:00", tz: "local" }, cron: "0 2 * * *",
    target: { console: "orchestrator", pane: "@scratch" },
    action: { kind: "knowledge", detail: "summarize blocks tagged #decisions, #architecture into a digest block", block: "blk_9a2c" },
    lastRun: "02:00 today · ✓", nextRun: "02:00 tomorrow",
  },
  {
    id: "S-02", name: "Pre-standup repo sync", on: true,
    when: { kind: "simple", every: "weekday", at: "08:45", tz: "local" }, cron: "45 8 * * 1-5",
    target: { console: "orchestrator", pane: "@github" },
    action: { kind: "command", detail: "git fetch --all && gh pr list --state open" },
    lastRun: "08:45 today · ✓", nextRun: "08:45 tomorrow",
  },
  {
    id: "S-03", name: "Bump weekly deps", on: true,
    when: { kind: "simple", every: "week", at: "09:00", tz: "local" }, cron: "0 9 * * 1",
    target: { console: "feat/tunnel", pane: "@scratch" },
    action: { kind: "command", detail: "cargo update && cargo test --workspace" },
    lastRun: "09:00 Mon · ✓", nextRun: "09:00 next Mon",
  },
  {
    id: "S-04", name: "Refresh review policy", on: true,
    when: { kind: "simple", every: "hour", at: ":15", tz: "local" }, cron: "15 * * * *",
    target: { console: "orchestrator", pane: "@reviewer" },
    action: { kind: "knowledge", detail: "pin blk_9a2c (Review policy — TS / Rust) into the pane context", block: "blk_9a2c" },
    lastRun: "14:15 · ✓", nextRun: "15:15 · in 22m",
  },
  {
    id: "S-05", name: "Pause overnight", on: false,
    when: { kind: "simple", every: "day", at: "22:00", tz: "local" }, cron: "0 22 * * *",
    target: { console: "all consoles", pane: "" },
    action: { kind: "command", detail: "base-studio mute --all && base-studio resume --at 07:00" },
    lastRun: "paused", nextRun: "—",
  },
];

export const AUTO_HISTORY: AutoHistoryRow[] = [
  ["14:15:02", "S-04", "Refresh review policy", "orch › @reviewer", "ok", "12s", "cron", "blk_9a2c pinned"],
  ["13:15:02", "S-04", "Refresh review policy", "orch › @reviewer", "ok", "9s", "cron", "blk_9a2c pinned · no change"],
  ["12:15:01", "S-04", "Refresh review policy", "orch › @reviewer", "warn", "2.1s", "cron", "stale credentials — refreshed silently"],
  ["11:15:00", "S-04", "Refresh review policy", "orch › @reviewer", "ok", "11s", "cron", "blk_9a2c pinned"],
  ["10:15:01", "S-04", "Refresh review policy", "orch › @reviewer", "ok", "10s", "cron", "blk_9a2c pinned"],
  ["09:00:04", "S-03", "Bump weekly deps", "feat/tunnel › @scratch", "fail", "1m 42s", "cron", "cargo test · 3 failures in ws-server"],
  ["09:00:01", "S-03", "Bump weekly deps", "feat/tunnel › @scratch", "ok", "52s", "cron", "cargo update · 8 crates updated"],
  ["08:45:03", "S-02", "Pre-standup repo sync", "orch › @github", "ok", "6s", "cron", "12 open PRs · 3 awaiting review"],
  ["08:00:00", "manual", "Re-pin review policy", "orch › @reviewer", "ok", "1s", "manual", "blk_9a2c pinned"],
  ["02:00:09", "S-01", "Nightly review digest", "orch › @scratch", "ok", "38s", "cron", "digest block updated (blk_d9f0)"],
  ["yesterday 22:14", "manual", "cargo test", "orch › @scratch", "fail", "5m 02s", "manual", "panic at orch/agent.rs:212"],
  ["yesterday 14:15", "S-04", "Refresh review policy", "orch › @reviewer", "ok", "9s", "cron", "blk_9a2c pinned"],
  ["yesterday 09:00", "S-03", "Bump weekly deps", "feat/tunnel › @scratch", "ok", "48s", "cron", "cargo update · all green"],
  ["yesterday 08:45", "S-02", "Pre-standup repo sync", "orch › @github", "ok", "6s", "cron", "9 open PRs"],
  ["yesterday 02:00", "S-01", "Nightly review digest", "orch › @scratch", "ok", "42s", "cron", "no new decisions; reused"],
  ["2d ago 02:00", "S-01", "Nightly review digest", "orch › @scratch", "warn", "1m 12s", "cron", "context cap hit; truncated 4 blocks"],
  ["3d ago 02:00", "S-01", "Nightly review digest", "orch › @scratch", "ok", "35s", "cron", "digest block updated (blk_d9c1)"],
  ["4d ago 02:00", "S-01", "Nightly review digest", "orch › @scratch", "fail", "6s", "cron", "claude · rate-limited; retried at 02:05 (ok)"],
].map(([when, sid, name, target, status, dur, trigger, out]) => ({
  when, sid, name, target, status: status as RunStatus, dur, trigger, out,
}));

export const AUTO_RUNS: Record<string, AutoRun[]> = {
  "S-01": [
    { when: "today 02:00", status: "ok", dur: "38s", out: "digest block updated (blk_d9f0)" },
    { when: "yesterday 02:00", status: "ok", dur: "42s", out: "no new decisions; reused" },
    { when: "2d ago 02:00", status: "warn", dur: "1m 12s", out: "context cap hit; truncated 4 blocks" },
    { when: "3d ago 02:00", status: "ok", dur: "35s", out: "digest block updated (blk_d9c1)" },
    { when: "4d ago 02:00", status: "fail", dur: "6s", out: "claude · rate-limited; retried at 02:05 (ok)" },
  ],
  "S-02": [
    { when: "today 08:45", status: "ok", dur: "6s", out: "12 open PRs · 3 awaiting review" },
    { when: "yesterday 08:45", status: "ok", dur: "6s", out: "9 open PRs" },
    { when: "2d ago 08:45", status: "ok", dur: "7s", out: "11 open PRs" },
  ],
  "S-03": [
    { when: "today 09:00", status: "fail", dur: "1m 42s", out: "cargo test · 3 failures in ws-server" },
    { when: "last Mon 09:00", status: "ok", dur: "48s", out: "cargo update · all green" },
    { when: "2w ago Mon", status: "ok", dur: "51s", out: "cargo update · 6 crates updated" },
  ],
  "S-04": [
    { when: "14:15", status: "ok", dur: "12s", out: "blk_9a2c pinned" },
    { when: "13:15", status: "ok", dur: "9s", out: "no change" },
    { when: "12:15", status: "warn", dur: "2.1s", out: "stale credentials — refreshed silently" },
    { when: "11:15", status: "ok", dur: "11s", out: "blk_9a2c pinned" },
    { when: "10:15", status: "ok", dur: "10s", out: "blk_9a2c pinned" },
  ],
  "S-05": [],
};
