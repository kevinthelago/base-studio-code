// Turn-accounting hooks (#3455) — the un-gated, pure-observability Claude Code hooks EVERY
// claude-launching session must register, kept in ONE place.
//
// WHY A SHARED CONSTANT. This exact set has now silently fallen out of a launch path TWICE:
//   · #3452 — the generic fleet/console path (`sessionLaunch.ts`) never registered `bsc-tokens`, so
//     tokens.log went dead for ~3 weeks and the whole cost subsystem read $0.
//   · #3455 — the bespoke planner launch passed `hooks: null`, so NO hook fired for the planner and
//     its (often large) planning cost was invisible.
// Both are the same failure mode: a session that logs nothing because the registration drifted out of
// one code path. A single exported constant that every launch path spreads makes that drift structural
// rather than silent — you cannot forget the list if there is only one list.
//
// SCOPE — observability only. These two hooks have NO behavioral effect (they only append a log line):
//   · bsc-activity (#1184) — authoritative turn boundaries (`run` on prompt, `idle` on Stop), so the
//     status dot doesn't false-idle a thinking session.
//   · bsc-tokens (#416) — `pane → session → transcript_path` to tokens.log at every turn end; the ONLY
//     per-session token source (Claude Code hooks don't expose usage), read by `bsc logs cost`, the
//     desktop cost UI, and `bsc metrics` (#3449).
// The GATING hooks (bsc-confine / bsc-deny / bsc-audit / bsc-scope / bsc-taint / bsc-defer) are NOT
// here — they change behavior and their per-path inclusion is a policy decision (the planner, plan-only
// in allow-list posture, deliberately omits them). This constant is the accounting floor, not the
// permission floor.

/** One Claude Code hook registration — `{event, matcher, command}`, the shape `ensure_session_settings`
 *  writes into `.claude/settings.json`. `matcher: ""` means "every tool / no matcher". */
export interface SessionHook {
  event: string;
  matcher: string;
  command: string;
}

/**
 * The turn-accounting hooks every claude session registers (see the module header). Spread into each
 * launch path's hook list — the generic `sessionHooks` (`sessionLaunch.ts`) AND the planner's two
 * `ensure_session_settings` calls (`usePlannerTerminal` / `usePlanMcpManagement`).
 *
 * A fresh array per read is not needed (the value is never mutated), but keep it readonly-in-spirit:
 * callers spread it, never push to it.
 */
export const TURN_ACCOUNTING_HOOKS: SessionHook[] = [
  { event: "UserPromptSubmit", matcher: "", command: "bsc-activity run" },
  // #4005 — Claude Code fires `Notification` when it needs the USER: most importantly "Claude needs
  // your permission to use <tool>", which under the default allow-list posture (#2050) is any command
  // outside `base.json`. That session is STOPPED, and until now nothing in the app could tell it apart
  // from one that was merely quiet — so the user had no way to know WHICH pane was asking.
  //
  // `Notification` also fires after a long input idle. That is likewise "needs you", so it is a
  // feature rather than a false positive. It is cleared by the ordinary turn boundaries below: the
  // next UserPromptSubmit records `run`, a Stop records `idle`. Without that a pane would stay
  // flagged forever after a single prompt.
  { event: "Notification", matcher: "", command: "bsc-activity attn" },
  { event: "Stop", matcher: "", command: "bsc-activity idle" },
  { event: "SubagentStop", matcher: "", command: "bsc-activity idle" },
  { event: "Stop", matcher: "", command: "bsc-tokens" },
  { event: "SubagentStop", matcher: "", command: "bsc-tokens" },
];
