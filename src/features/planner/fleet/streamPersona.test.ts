import { describe, it, expect } from "vitest";
import { resolveStreamPersona, personaStreamPrompt } from "./streamPersona";
import type { AgentStream } from "./planFleet";
import type { Persona } from "@/features/personas";

const stream = (over: Partial<AgentStream> = {}): AgentStream => ({
  id: "auth", name: "Auth", repo: "o/r", owns: ["src/auth/"], issues: ["#12"], dependsOn: [], ...over,
});
const persona = (over: Partial<Persona> = {}): Persona => ({
  id: "persona-x", name: "X", blurb: "", role: "worker", startPrompt: "You are X.", skills: [], ...over,
});

describe("resolveStreamPersona (#2094)", () => {
  const lib = [persona({ id: "persona-worker" }), persona({ id: "persona-juror", role: "juror" })];
  it("resolves a stream's persona reference", () => {
    expect(resolveStreamPersona(lib, stream({ persona: "persona-juror" }))?.role).toBe("juror");
  });
  it("returns undefined for no reference or an unknown id", () => {
    expect(resolveStreamPersona(lib, stream())).toBeUndefined();
    expect(resolveStreamPersona(lib, stream({ persona: "persona-nope" }))).toBeUndefined();
  });
});

describe("personaStreamPrompt (#2094)", () => {
  it("leads with the persona's start prompt + the shared scope facts", () => {
    const out = personaStreamPrompt(persona({ startPrompt: "You are the Documentor." }), stream());
    expect(out.startsWith("You are the Documentor.")).toBe(true);
    expect(out).toContain("branch auth");     // worktree/branch fact
    expect(out).toContain("#12");             // assigned issue
    expect(out).toContain("src/auth/");       // owned scope
  });

  it("a WRITING role gets the worker autonomy/push prose", () => {
    const out = personaStreamPrompt(persona({ role: "worker" }), stream());
    // The flow kickoff (worker) mentions PRs/pushing; it must NOT be the read-only note.
    expect(out).not.toContain("This is a read-only role");
  });

  it("a READ-ONLY role gets the report-don't-commit instruction, not worker push prose", () => {
    const out = personaStreamPrompt(persona({ role: "juror" }), stream());
    expect(out).toContain("This is a read-only role");
    expect(out).toContain("do not commit, push, or open PRs");
  });

  // #2416: the scope prose + read-only closing moved to `@data/fleet/persona-kickoff.json` (TS keeps
  // interpolation only) — pin the rendered kickoff byte-identical to the previous TS-authored output.
  it("renders byte-identical to the pre-@data TS strings (#2416, read-only role)", () => {
    const out = personaStreamPrompt(persona({ role: "juror", startPrompt: "You are X." }), stream());
    expect(out).toBe(
      "You are X.\n\n" +
      `You are the "Auth" stream in a parallel fleet, working in your own git worktree on branch auth — ` +
      `do not switch branches or touch other worktrees. Your assigned issues: #12. Your scope: you own src/auth/; ` +
      `stay within it and coordinate anything cross-cutting through the director. Integration interfaces between features ` +
      `live in the contracts directory — read them as the source of truth, and ask the director if one is unclear or must change. ` +
      `When you pause or finish a work session, pipe a short note of where you left off and the next step into bsc-checkpoint on stdin. ` +
      `This is a read-only role: report what you find by piping notes into bsc-note on stdin; do not commit, push, or open PRs. ` +
      `Verify your work against the repo tests and CI rather than asking whether it is correct.`,
    );
  });

  it("empty owns/issues render the explicit fallbacks, byte-identical (#2416)", () => {
    const out = personaStreamPrompt(persona({ role: "juror", startPrompt: "" }), stream({ owns: [], issues: [] }));
    expect(out.startsWith(`You are the "Auth" stream`)).toBe(true); // no intro → no leading blank lines
    expect(out).toContain("Your assigned issues: the issues assigned to your area.");
    expect(out).toContain("you own the files for your area;");
  });
});
