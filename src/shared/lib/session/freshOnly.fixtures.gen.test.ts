// The fresh-only kickoff decision, captured from the LIVE TypeScript so the Rust derivation can be
// proved equal.
//
// `plan_launch` (src-tauri/src/console/pty/launch.rs) computes `suppress = fresh_only && has_history`
// and decides whether a session is re-greeted or resumes quietly. It cannot compute `fresh_only` —
// that arrives as a `pty_create` argument from the renderer, defaulting to false when absent. Rust owns
// the consequence; the frontend owns the decision.
//
// This is the rule the local-model kickoff loop turned on: the predicate used to be gated on
// `isClaudeProvider`, so a local pane never suppressed its kickoff and was re-instructed on every
// launch.
//
// BOTH FAILURE DIRECTIONS ARE DOCUMENTED BUGS, and they are not symmetric. Over-suppressing strands a
// session with no instructions at an empty prompt (the per-request debug sessions, which resume
// nothing); under-suppressing merely re-greets. So a port must fail toward re-greeting.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/session/freshOnly.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveStartupPromptFreshOnly } from "@/app/console/lib/sessionLaunch";
import { STUDIO_SESSION_PANE_IDS, DEBUG_STUDIO_SESSION_ID, DEBUG_STUDIO_PANE_PREFIX } from "@/shared/lib/session/systemSessions";
import type { AppStore } from "@/store/types";

const FIXTURE = join(process.cwd(), "src/shared/lib/session/freshOnly.fixtures.json");

const store = (restore: Record<string, boolean>) => ({ restoreRequested: restore }) as unknown as AppStore;

type Case = { label: string; paneId: string; restore?: boolean };

const SUBJECTS: Case[] = [
  // Every fixed app-owned studio session — these genuinely resume across restarts.
  ...STUDIO_SESSION_PANE_IDS.map((id) => ({ label: `studio session ${id}`, paneId: id })),

  // THE DOCUMENTED BUG: the per-request debug sessions share the `debug-studio:` PREFIX with the
  // standing debugger but resume nothing, so suppressing their charter strands them.
  { label: "the STANDING debug session IS fresh-only", paneId: DEBUG_STUDIO_SESSION_ID },
  { label: "a PER-REQUEST debug session is NOT — it resumes nothing", paneId: `${DEBUG_STUDIO_PANE_PREFIX}req-4212` },
  { label: "another per-request debug session", paneId: `${DEBUG_STUDIO_PANE_PREFIX}req-99` },

  // Ordinary panes.
  { label: "a fleet worker pane", paneId: "studio-code:kernel" },
  { label: "a fleet worker pane being crash-RESTORED", paneId: "studio-code:kernel", restore: true },
  { label: "a director pane", paneId: "studio-code:director" },
  { label: "a triage pane", paneId: "studio-code:base-studio-code:triage" },
  { label: "a triage pane being restored", paneId: "studio-code:base-studio-code:triage", restore: true },

  // A manual console is NEVER fresh-only (#1176) — not even when restore is requested. The id shape is
  // `man:<tabId>:p<idx>` (`manualPaneId`), NOT the `t<n>p<n>` positional id: those are two different
  // schemes and only the `man:` prefix is what `isManualPaneId` reads.
  { label: "a manual console", paneId: "man:tab1:p0" },
  { label: "a manual console WITH restore requested — still never fresh-only", paneId: "man:tab1:p0", restore: true },
  { label: "another manual console", paneId: "man:tab2:p3" },
  // The POSITIONAL id, kept as a contrast case: it is not manual, so the restore flag does apply. The
  // two schemes look interchangeable and are not.
  { label: "a POSITIONAL pane id is not a manual one", paneId: "t0p0" },
  { label: "a positional pane id being restored — the restore DOES apply", paneId: "t0p0", restore: true },

  { label: "an unknown pane id", paneId: "something-else" },
  { label: "an unknown pane id being restored", paneId: "something-else", restore: true },
  { label: "the empty pane id", paneId: "" },
];

/** The provider argument is deliberately NOT this rule's business — the record says so in place. Both
 *  values are captured so a port cannot quietly reintroduce the `isClaudeProvider` gate that made every
 *  protection here Claude-only. */
const PROVIDERS = [true, false];

describe("freshOnly fixtures", () => {
  it("captures the decision over every studio id and edge case", () => {
    const cases = SUBJECTS.map((c) => {
      const s = store(c.restore ? { [c.paneId]: true } : {});
      const byProvider = PROVIDERS.map((isClaude) => resolveStartupPromptFreshOnly(s, c.paneId, isClaude));
      return {
        label: c.label,
        paneId: c.paneId,
        restoreRequested: !!c.restore,
        freshOnly: byProvider[0],
        // Pinned so the harness gate cannot come back: both providers must agree.
        freshOnlyNonClaude: byProvider[1],
      };
    });
    const next = {
      note: "GENERATED from @/app/console/lib/sessionLaunch resolveStartupPromptFreshOnly — do not hand-edit; see the .gen.test.ts",
      studioPaneIds: [...STUDIO_SESSION_PANE_IDS],
      cases,
    };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("THE HARNESS GATE IS GONE: the decision never differs by provider", () => {
    // Gating on `isClaudeProvider` is what made a local pane re-instructed on every launch. If a port
    // reintroduces it, this is the test that names why it matters.
    for (const c of SUBJECTS) {
      const s = store(c.restore ? { [c.paneId]: true } : {});
      expect(
        resolveStartupPromptFreshOnly(s, c.paneId, true),
        `${c.label}: the rule is about RESUMING, and bsc-agent resumes too`,
      ).toBe(resolveStartupPromptFreshOnly(s, c.paneId, false));
    }
  });

  it("is non-vacuous: the decision is true for some panes and false for others", () => {
    const vals = SUBJECTS.map((c) => resolveStartupPromptFreshOnly(store(c.restore ? { [c.paneId]: true } : {}), c.paneId, true));
    expect(vals.filter(Boolean).length, "nothing was fresh-only").toBeGreaterThan(2);
    expect(vals.filter((v) => !v).length, "everything was fresh-only").toBeGreaterThan(2);
  });

  it("the per-request debug session is NOT fresh-only while the standing one IS", () => {
    // The distinction the prefix predicate got wrong, asserted directly because it is the whole point.
    expect(resolveStartupPromptFreshOnly(store({}), DEBUG_STUDIO_SESSION_ID, true)).toBe(true);
    expect(
      resolveStartupPromptFreshOnly(store({}), `${DEBUG_STUDIO_PANE_PREFIX}req-1`, true),
      "a per-request session resumes nothing — suppressing its charter strands it at an empty prompt",
    ).toBe(false);
  });
});
