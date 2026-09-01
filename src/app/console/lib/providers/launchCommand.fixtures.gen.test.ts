// The non-Claude launch command, captured from the LIVE TypeScript so the Rust builder can be proved
// equal. The PTY that runs this string is Rust; the string was assembled in the renderer.
//
// THE QUOTING IS THE PART THAT MATTERS. The kickoff prompt is interpolated as
// `--message <shQuote(prompt)>`, and that prompt is PLAN-AUTHORED text — a stream kickoff the planner
// wrote, or a checkpoint note. POSIX single-quoting escapes embedded quotes as `'\''`, so a prompt
// containing an apostrophe cannot terminate the argument and what follows cannot become shell. A port
// that reaches for `format!("--message '{prompt}'")` is a command injection in a string built from
// content the planner writes — so the subjects below carry apostrophes, quote sequences and newlines.
//
//     UPDATE_FIXTURES=1 npx vitest run src/app/console/lib/providers/launchCommand.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildAiderCommand } from "@/app/console/lib/providers/providers/aider";
import type { ProviderLaunchConfig } from "@/app/console/lib/providers";
import type { LlmConfig } from "@/shared/lib/core/llmConfig";

const FIXTURE = join(process.cwd(), "src/app/console/lib/providers/launchCommand.fixtures.json");

const llm = (over: Partial<LlmConfig> = {}): LlmConfig =>
  ({ provider: "anthropic", model: "opus-4.5", apiKey: "", baseUrl: "", numCtx: undefined, ...over });

type Case = { label: string; config?: ProviderLaunchConfig };

const SUBJECTS: Case[] = [
  { label: "no config at all — the bare fleet-safe launch" },
  { label: "an empty config", config: {} },

  // Model selection: llm wins over a bare model, and neither means NO --model flag.
  { label: "an llm config supplies the model", config: { llm: llm() } },
  { label: "a local llm config", config: { llm: llm({ provider: "ollama", model: "qwen2.5-coder" }) } },
  { label: "a bare model string, no llm", config: { model: "gpt-4o" } },
  { label: "llm WINS over a bare model string", config: { llm: llm(), model: "ignored-model" } },
  { label: "a whitespace-only model emits NO flag", config: { model: "   " } },
  { label: "an empty model emits no flag", config: { model: "" } },

  // Read-only files — a worker's plan scope.
  { label: "one read file", config: { readFiles: ["CLAUDE.local.md"] } },
  { label: "several read files", config: { readFiles: ["CLAUDE.local.md", "docs/plan.md"] } },
  { label: "a read file with a space in its name", config: { readFiles: ["my notes.md"] } },
  { label: "a read file with an APOSTROPHE", config: { readFiles: ["worker's plan.md"] } },

  // THE QUOTING CORPUS. Each of these breaks a naive interpolation.
  { label: "a plain prompt", config: { startupPrompt: "do the thing" } },
  { label: "a prompt with an APOSTROPHE", config: { startupPrompt: "don't stop" } },
  { label: "a prompt that tries to CLOSE the quote and run a command", config: { startupPrompt: "x'; rm -rf /tmp/pwned; echo '" } },
  { label: "a prompt with a double quote", config: { startupPrompt: 'say "hello"' } },
  { label: "a prompt with a backtick and a dollar", config: { startupPrompt: "cost is `date` and $HOME" } },
  { label: "a MULTI-LINE prompt — newlines survive inside single quotes", config: { startupPrompt: "line one\nline two\nline three" } },
  { label: "a whitespace-only prompt emits NO --message", config: { startupPrompt: "   " } },
  { label: "an empty prompt emits no --message", config: { startupPrompt: "" } },

  { label: "everything at once", config: { llm: llm({ provider: "ollama", model: "qwen" }), readFiles: ["CLAUDE.local.md"], startupPrompt: "ship it — don't wait" } },
];

describe("launchCommand fixtures", () => {
  it("captures buildAiderCommand over every shape", () => {
    const cases = SUBJECTS.map((c) => ({ label: c.label, config: c.config ?? null, cmd: buildAiderCommand(c.config) }));
    const next = { note: "GENERATED from @/app/console/lib/providers/providers/aider — do not hand-edit; see the .gen.test.ts", cases };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("THE INJECTION CASE: a prompt cannot close its own quote", () => {
    const evil = "x'; rm -rf /tmp/pwned; echo '";
    const cmd = buildAiderCommand({ startupPrompt: evil });
    // A naive `--message '<prompt>'` would produce a command with an unquoted `rm -rf` in it.
    expect(cmd, "the payload must stay INSIDE one quoted argument").not.toMatch(/--message '[^']*'; rm/);
    expect(cmd).toContain("'\\''");
  });

  it("the fleet-safe git flags are unconditional", () => {
    for (const c of SUBJECTS) {
      const cmd = buildAiderCommand(c.config);
      expect(cmd, `${c.label}: a surprise commit on the pane's branch`).toContain("--no-auto-commits");
      expect(cmd).toContain("--no-dirty-commits");
    }
  });

  it("with no model at all, NO --model flag is emitted", () => {
    expect(buildAiderCommand({})).not.toContain("--model");
    expect(buildAiderCommand({ model: "   " }), "an empty --model would be an error, not a default").not.toContain("--model");
  });

  it("a multi-line prompt survives intact", () => {
    const cmd = buildAiderCommand({ startupPrompt: "a\nb" });
    expect(cmd, "newlines are legal inside single quotes").toContain("a\nb");
  });
});
