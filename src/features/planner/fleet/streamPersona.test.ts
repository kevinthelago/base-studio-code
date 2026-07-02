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
});
