// The debug session is described TWICE, and the two copies drifted — this pins them together.
//
// `DEBUG_ROLE_PROMPT` (the `request-session.ts` record) is the prose EVERY debug session launches with,
// prepended to the per-request charter. `personas/debugger.json` is the persona the Studio Network
// places and the Personas library shows. One session, two descriptions.
//
// WHAT THEY BOTH GOT WRONG. Both opened with "your job: improve the `bsc ui` surface so the Design
// Studio's designer session never needs permissions outside it" — true when the request queue was the
// designer's alone, and false since the architect, librarian, sound designer, directors and dev
// sessions started filing onto the same queue. Measured on the live queue when this was fixed, the open
// requests named `bsc navigate`, `bsc ui`, `bsc graph`, `bsc plan` and `bsc fleet` — five surfaces
// resolving to five different crates — and the persona went further, telling the session to "implement
// the fix in crates/bsc-ui". A debug session spawned for a `bsc graph` request was being told its job
// was somewhere else. The role prompt even contradicted itself one sentence later ("implement the fix
// in the owning crate"), which is the instruction that was always right.
//
// Three workflow rules were stale in the same prose, each one the repo has since reversed: open a PR
// (this repo is local-first and writes nothing to GitHub), work under `.claude/worktrees/` (write-denied
// mid-session), and a "gate" spelled out as cargo check + clippy + typecheck/lint — which names no test
// runner at all, so a session following it literally would never run a test.
import { describe, it, expect } from "vitest";
import { DEBUG_ROLE_PROMPT } from "@/features/debug/requestSession";
import debuggerPersona from "@data/personas/debugger.json";

/** The persona's prose, as one blob — blurb + start prompt + responsibilities are all instructions the
 *  session or its reader acts on, and the drift showed up in all three. */
const personaProse = [
  debuggerPersona.blurb,
  debuggerPersona.startPrompt,
  ...(debuggerPersona.responsibilities ?? []),
].join("\n");

const COPIES: ReadonlyArray<readonly [string, string]> = [
  ["DEBUG_ROLE_PROMPT", DEBUG_ROLE_PROMPT],
  ["personas/debugger.json", personaProse],
];

describe("the two descriptions of the debug session agree", () => {
  it.each(COPIES)("%s scopes the session to the WHOLE app, not one surface", (_name, prose) => {
    // The positive claim. "the owning crate" is the operative instruction: the session follows the
    // failing verb to whatever owns it rather than assuming a home.
    expect(prose).toMatch(/owning crate/i);
    expect(prose).toMatch(/whole application/i);
  });

  it.each(COPIES)("%s does not re-scope the session to bsc ui or the designer", (_name, prose) => {
    // The regression, asserted as an absence. Naming a crate or a single filer here re-scopes every
    // debug session to whichever gap happened to be common the week the sentence was written.
    expect(prose).not.toMatch(/improve the `bsc ui` surface/i);
    expect(prose).not.toMatch(/crates\/bsc-ui/);
    expect(prose).not.toMatch(/so the Design Studio's designer session never needs/i);
  });

  it.each(COPIES)("%s names the one queue every session files onto", (_name, prose) => {
    // Why the scope is what it is: the queue is shared, so the work cannot be predicted from a surface.
    expect(prose).toContain("bsc request");
    for (const filer of ["architect", "designer", "librarian"]) {
      expect(prose.toLowerCase()).toContain(filer);
    }
  });

  it.each(COPIES)("%s names a gate that actually runs the tests", (_name, prose) => {
    // The old spelling — "cargo check + clippy --all-targets + typecheck/lint" — names no test runner,
    // and this repo's recurring failure is a gate that passes while covering less than the reader
    // assumes. `npm run gate -- --full` is the unscoped one that step 7 requires before anything lands.
    expect(prose).toContain("npm run gate -- --full");
  });

  it.each(COPIES)("%s tells it to track the work in the plan store", (_name, prose) => {
    // Every slice here gets an item AND a change record; a slice worked without one leaves no gate
    // evidence and no reviewer verdict.
    expect(prose).toContain("bsc plan change");
  });

  it.each(COPIES)("%s is LOCAL-FIRST — no PR, no push, no GitHub write", (_name, prose) => {
    expect(prose).toMatch(/never (push|open a PR)/i);
    expect(prose).not.toMatch(/and open a PR/i);
  });

  it.each(COPIES)("%s sends it to a repo-root wt-<short> worktree, not .claude/worktrees", (_name, prose) => {
    // `.claude/worktrees/` is write-denied mid-session, so the old instruction sent every debug session
    // at a directory it cannot create. A nested `wt-<short>` is also zero-install.
    expect(prose).toContain("wt-<short>");
    expect(prose).not.toContain(".claude/worktrees/<branch>");
  });

  it("keeps the persona's floor agreeing with its own prose", () => {
    // The architect defect in miniature: instructions that forbid what the floor permits. The prose says
    // it never writes to GitHub, so the axis says `read`. git/code/ui stay write — that is the job.
    expect(debuggerPersona.floor?.github).toBe("read");
    expect(debuggerPersona.floor?.git).toBe("write");
    expect(debuggerPersona.floor?.code).toBe("write");
  });
});
