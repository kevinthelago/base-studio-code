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
import { getProvider, listProviders } from "@/app/console/lib/providers/registry";
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

// ── THE WHOLE REGISTRY, not just Aider (#the-console-provider-set-builds-its-launch-command-in-rust)
//
// Rust built a command for `aider` alone and returned `None` for everything else, on the stated
// grounds that the rest BAKE their own prompt. That is true of `claude` and `bsc-agent` and false of
// `gemini`, `codex`, `amazonq` and `ollama`, which the TypeScript builds real commands for — so the
// app asked the sidecar, got absence, and fell back to this copy with nothing measuring the gap.
//
// `amazonq` is the one that cannot be guessed: its provider id is `amazonq` and its BINARY is `q`.
//
// Captured through `getProvider(id).buildLaunchCmd(...)` — the live registry, the same entry point
// the console uses — rather than by importing each module, so a provider that stops being registered
// shows up here as a missing subject instead of passing quietly.
type ProviderCase = { id: string; label: string; config?: ProviderLaunchConfig };

const PROVIDER_SUBJECTS: ProviderCase[] = [
  // Aider is exercised exhaustively by `cases` above; it appears here too so the completeness guard
  // below covers the WHOLE registry, and so the registry entry point is proved to reach the same
  // builder that `cases` calls directly.
  { id: "aider", label: "aider — through the registry, not the module" },
  { id: "claude", label: "claude — bakes its own prompt via pty_create" },
  { id: "gemini", label: "gemini — a bare constant" },
  { id: "codex", label: "codex — a bare constant" },
  { id: "amazonq", label: "amazonq — the id is `amazonq`, the BINARY is `q`" },
  { id: "bsc-agent", label: "bsc-agent — bakes its own prompt" },

  // Ollama is the only non-Aider provider that INTERPOLATES, and it does so unquoted.
  { id: "ollama", label: "ollama — no model, so the built-in default" },
  { id: "ollama", label: "ollama — an explicit model", config: { model: "qwen2.5-coder" } },
  { id: "ollama", label: "ollama — a tagged model", config: { model: "llama3:70b" } },
  { id: "ollama", label: "ollama — a namespaced model", config: { model: "library/llama3" } },
  { id: "ollama", label: "ollama — an empty model falls back to the default", config: { model: "" } },
  // THE INJECTION SUBJECTS. The TypeScript emits these UNQUOTED; the capture records that faithfully,
  // and the Rust builder deliberately differs by quoting them. See the fixture note.
  { id: "ollama", label: "ollama — a model with a SPACE", config: { model: "my model" } },
  { id: "ollama", label: "ollama — a model that tries to CHAIN a command", config: { model: "llama3; rm -rf /tmp/pwned" } },
  { id: "ollama", label: "ollama — a model with a backtick and a dollar", config: { model: "a`date`$HOME" } },
];

describe("launchCommand fixtures", () => {
  it("captures buildAiderCommand over every shape", () => {
    const cases = SUBJECTS.map((c) => ({ label: c.label, config: c.config ?? null, cmd: buildAiderCommand(c.config) }));
    const providers = PROVIDER_SUBJECTS.map((c) => {
      const p = getProvider(c.id);
      if (!p) throw new Error(`provider ${c.id} is not registered — the registry moved, not the fixture`);
      return { id: c.id, label: c.label, config: c.config ?? null, cmd: p.buildLaunchCmd(c.config) };
    });
    const next = {
      note:
        "GENERATED from @/app/console/lib/providers — do not hand-edit; see the .gen.test.ts. `cases` is " +
        "buildAiderCommand; `providers` is every registered provider through getProvider().buildLaunchCmd(). " +
        "NOTE the ollama injection subjects are recorded UNQUOTED because that is what the TypeScript " +
        "emits — the Rust builder quotes them on purpose and its own test states that divergence.",
      cases,
      providers,
    };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("every REGISTERED provider is captured, so a new one cannot land unmeasured", () => {
    const captured = new Set(PROVIDER_SUBJECTS.map((c) => c.id));
    const registered = listProviders().map((p) => p.id);
    expect(registered.length, "the registry seeds its built-ins on import").toBeGreaterThan(0);
    for (const id of registered) {
      expect(captured.has(id), `provider "${id}" is registered but has no fixture subject`).toBe(true);
    }
  });

  it("ollama interpolates its model UNQUOTED — the reason the Rust builder diverges", () => {
    // Pinned as the CURRENT TypeScript behaviour, not as desirable behaviour. The model can arrive
    // from a store record, a persona placement or argv, and this string is executed by a PTY.
    const cmd = getProvider("ollama")!.buildLaunchCmd({ model: "llama3; rm -rf /tmp/pwned" });
    expect(cmd).toBe("ollama run llama3; rm -rf /tmp/pwned");
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
