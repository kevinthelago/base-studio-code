// The resume command, captured from the LIVE TypeScript so the Rust resolution can be proved equal.
//
// `plan_launch` (src-tauri/src/console/pty/launch.rs) consumes the `init_cmd` this produces and cannot
// compute it. Every failure mode the function guards against was a session that came up wrong and said
// nothing:
//
//   · a resuming pane whose `explicit` is the bare harness placeholder used to return it verbatim, so a
//     resumed worker opened a NEW conversation beside the old one — and a `bsc-agent` pane resumed into
//     CLAUDE, silently ignoring its local model (#173);
//   · an EMPTY startup prompt returned "" and the pane came up a bare shell, because an empty string is
//     discarded downstream too;
//   · `continueSession` used to require `paneWasClaude`, which deadlocked — that flag is only set once
//     claude has started, so 77 of 78 fleet panes could never be resumed at all.
//
// A clean quit must resume NOTHING. That is asserted rather than assumed, because this function is one
// edit away from starting sessions by itself.
//
//     UPDATE_FIXTURES=1 npx vitest run src/app/console/lib/resumeCommand.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveInitCmd } from "@/app/console/lib/resumeClaude";
import { CONTINUE_OR_FRESH, continueOrFresh } from "@/shared/lib/session/ensureClaudeRunning";

const FIXTURE = join(process.cwd(), "src/app/console/lib/resumeCommand.fixtures.json");

type Args = Parameters<typeof resolveInitCmd>[0];
const args = (over: Partial<Args> = {}): Args => ({
  explicit: undefined, startupPrompt: undefined, continueSession: false,
  paneWasClaude: false, autoResumeClaude: false, wasUncleanShutdown: false, restoreRequested: false,
  ...over,
});

type Case = { label: string; args: Args };

const SUBJECTS: Case[] = [
  { label: "nothing set — a clean quit resumes NOTHING", args: args() },

  // The three resume signals, each alone.
  { label: "signal 1: an explicit fleet/triage resume", args: args({ continueSession: true }) },
  { label: "signal 2: the crash banner's Restore click", args: args({ paneWasClaude: true, restoreRequested: true }) },
  { label: "signal 3: silent auto-resume after an unclean shutdown", args: args({ paneWasClaude: true, autoResumeClaude: true, wasUncleanShutdown: true }) },

  // #3986: continueSession ALONE, without paneWasClaude — the conjunction that deadlocked.
  { label: "continueSession WITHOUT paneWasClaude — the 77-of-78 case", args: args({ continueSession: true, paneWasClaude: false }) },
  { label: "restoreRequested WITHOUT paneWasClaude — still gated on it", args: args({ restoreRequested: true, paneWasClaude: false }) },
  { label: "auto-resume WITHOUT paneWasClaude", args: args({ autoResumeClaude: true, wasUncleanShutdown: true, paneWasClaude: false }) },
  { label: "auto-resume armed but the shutdown was CLEAN", args: args({ paneWasClaude: true, autoResumeClaude: true, wasUncleanShutdown: false }) },
  { label: "unclean shutdown but auto-resume NOT armed", args: args({ paneWasClaude: true, autoResumeClaude: false, wasUncleanShutdown: true }) },

  // The harness placeholder — the bug that sent a resumed worker to an empty conversation.
  { label: "placeholder `claude`, NOT resuming — returned verbatim", args: args({ explicit: "claude" }) },
  { label: "placeholder `claude`, RESUMING — becomes the resume form", args: args({ explicit: "claude", continueSession: true }) },
  { label: "placeholder `bsc-agent`, RESUMING — #173, must NOT become claude", args: args({ explicit: "bsc-agent", continueSession: true }) },
  { label: "placeholder `bsc-agent`, not resuming", args: args({ explicit: "bsc-agent" }) },
  { label: "placeholder with surrounding whitespace, resuming", args: args({ explicit: "  claude  ", continueSession: true }) },

  // A REAL override must win untouched, even on a resume.
  { label: "a real override with flags, resuming — wins untouched", args: args({ explicit: "aider --message go", continueSession: true }) },
  { label: "a real override, not resuming", args: args({ explicit: "./my-wrapper.sh" }) },
  { label: "an override that merely CONTAINS the harness name", args: args({ explicit: "claude --model opus", continueSession: true }) },

  // startupPrompt: TRUTHY, not defined-ness.
  { label: "a startup prompt wins over a resume", args: args({ startupPrompt: "do the thing", continueSession: true }) },
  { label: "an EMPTY startup prompt falls THROUGH to the resume", args: args({ startupPrompt: "", continueSession: true }) },
  { label: "an empty startup prompt with no resume signal", args: args({ startupPrompt: "" }) },
  { label: "a startup prompt AND an explicit override — explicit is checked first", args: args({ explicit: "aider --message go", startupPrompt: "kickoff" }) },
];

describe("resumeCommand fixtures", () => {
  it("captures resolveInitCmd over every signal combination", () => {
    const cases = SUBJECTS.map((c) => ({ label: c.label, args: c.args, cmd: resolveInitCmd(c.args) }));
    const next = {
      note: "GENERATED from @/app/console/lib/resumeClaude — do not hand-edit; see the .gen.test.ts",
      continueOrFresh: CONTINUE_OR_FRESH,
      continueOrFreshBscAgent: continueOrFresh("bsc-agent"),
      cases,
    };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("A CLEAN QUIT RESUMES NOTHING — the app must not start sessions by itself", () => {
    expect(resolveInitCmd(args()), "no signal, no command").toBe("");
    expect(resolveInitCmd(args({ paneWasClaude: true })), "having BEEN claude is not a resume signal").toBe("");
  });

  it("#173: a resuming bsc-agent pane resumes BSC-AGENT, never claude", () => {
    const cmd = resolveInitCmd(args({ explicit: "bsc-agent", continueSession: true }));
    expect(cmd, "the resume form is derived from the placeholder").toContain("bsc-agent");
    expect(cmd.startsWith("claude"), "resuming into claude silently ignores the configured local model").toBe(false);
  });

  it("an empty startup prompt does NOT short-circuit — it fell through to a bare shell", () => {
    expect(resolveInitCmd(args({ startupPrompt: "", continueSession: true })), "empty is not a prompt").not.toBe("");
    expect(resolveInitCmd(args({ startupPrompt: "real", continueSession: true })), "a real prompt wins").toBe("");
  });
});
