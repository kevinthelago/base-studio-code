// The pane's provider/model routing, captured from the LIVE TypeScript so the Rust port can be proved
// equal.
//
// `paneLlmConfig` decides WHICH ENDPOINT an agent process talks to. `session/harness.rs` says outright
// that "provider/model/permissions come from env" — Rust spawns the process and consumes the resolved
// provider and model without being able to derive them. So the renderer picks the endpoint and the
// backend obeys, which is the inversion this epic exists to close.
//
// The interesting rule is #173's: a NON-tier model on a HOSTED provider means this pane was given a
// local model by its stream while the fleet-wide provider is still Claude/OpenAI/Gemini. The hosted
// provider and key do not apply to it at all, so it must be re-routed to ollama at the configured local
// endpoint. Silently keeping the hosted provider is the bug the rule exists to prevent.
//
// SCOPE: the fixture records the RESOLVED global config as the input, not the raw store. `resolveLlmConfig`
// is a separate concern (which key goes with which provider) and porting it is not this slice — so the
// Rust contract is (resolved global config, this pane's model) → the pane's effective config.
//
//     UPDATE_FIXTURES=1 npx vitest run src/app/console/lib/paneLlmRouting.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paneLlmConfig } from "@/app/console/lib/sessionLaunch";
import { MODEL_IDS } from "@/app/console/lib/models";
import type { AppStore } from "@/store/types";

const FIXTURE = join(process.cwd(), "src/app/console/lib/paneLlmRouting.fixtures.json");

/** The store fields this routing actually reads. A partial snapshot is deliberate and is what the
 *  record's own carried tests do — `paneLlmConfig` optional-chains `paneModels` precisely because it
 *  runs on the launch path before anything guarantees the map is populated. */
type Snap = {
  llmProvider: string;
  llmModel?: string;
  claudeApiKey?: string;
  openaiKey?: string;
  geminiKey?: string;
  localBaseUrl?: string;
  llmNumCtx?: string;
  paneModels?: Record<string, string>;
};

const PANE = "p1";

/** `resolveLlmConfig` reads these unconditionally (`resolveModel` trims `llmModel`), so a snapshot
 *  that omits them throws before the routing under test is reached. Defaulted here rather than
 *  repeated on every subject. */
const store = (s: Snap) =>
  ({ llmModel: "", claudeApiKey: "", openaiKey: "", geminiKey: "", localBaseUrl: "", llmNumCtx: "", paneModels: {}, ...s }) as unknown as AppStore;

/** Subjects: every rule, and the shapes that separate them. */
const SUBJECTS: Array<[string, Snap]> = [
  // Rule 1 — no per-pane model: the global config, untouched.
  ["rule 1: no pane model at all", { llmProvider: "anthropic", claudeApiKey: "sk-a" }],
  ["rule 1: paneModels present but not for THIS pane", { llmProvider: "anthropic", claudeApiKey: "sk-a", paneModels: { other: "llama3" } }],
  ["rule 1: paneModels missing entirely — the launch-path shape", { llmProvider: "ollama", localBaseUrl: "http://box:11434/v1" }],

  // Rule 2 — a known TIER id is the global's business, so the global config is returned unchanged.
  ...MODEL_IDS.map((id) => [
    `rule 2: pane model is the shipped tier ${id}`,
    { llmProvider: "anthropic", claudeApiKey: "sk-a", paneModels: { [PANE]: id } },
  ] as [string, Snap]),

  // Rule 3 — provider ALREADY needs bsc-agent (local/ollama): keep it, swap in the pane's model.
  ["rule 3: ollama provider keeps its endpoint, takes the pane model", { llmProvider: "ollama", localBaseUrl: "http://box:11434/v1", paneModels: { [PANE]: "qwen2.5-coder" } }],
  ["rule 3: local provider likewise", { llmProvider: "local", localBaseUrl: "http://box:11434/v1", paneModels: { [PANE]: "qwen2.5-coder" } }],
  ["rule 3: ollama with NO base url configured", { llmProvider: "ollama", paneModels: { [PANE]: "qwen2.5-coder" } }],
  ["rule 3: numCtx rides along", { llmProvider: "ollama", llmNumCtx: "65536", paneModels: { [PANE]: "qwen2.5-coder" } }],

  // Rule 4 — THE #173 CASE. A non-tier model on a hosted provider is a local model the stream chose;
  // the hosted provider and key do not apply, so re-route to ollama.
  ["rule 4 (#173): non-tier model on anthropic re-routes to ollama", { llmProvider: "anthropic", claudeApiKey: "sk-a", paneModels: { [PANE]: "qwen2.5-coder" } }],
  ["rule 4 (#173): the api key must NOT survive the reroute", { llmProvider: "openai", openaiKey: "sk-o", paneModels: { [PANE]: "llama3.1" } }],
  ["rule 4 (#173): gemini too", { llmProvider: "gemini", geminiKey: "sk-g", paneModels: { [PANE]: "llama3.1" } }],
  ["rule 4: configured local endpoint is used when present", { llmProvider: "anthropic", claudeApiKey: "sk-a", localBaseUrl: "http://box:11434/v1", paneModels: { [PANE]: "llama3.1" } }],
  ["rule 4: NO local endpoint configured — the default must appear", { llmProvider: "anthropic", claudeApiKey: "sk-a", paneModels: { [PANE]: "llama3.1" } }],
  ["rule 4: numCtx survives the reroute", { llmProvider: "anthropic", claudeApiKey: "sk-a", llmNumCtx: "32768", paneModels: { [PANE]: "llama3.1" } }],

  // The suspected divergence, put in the fixture rather than argued about: the TypeScript uses `||`
  // (a FALSY test) while Rust's resolve_base_url filters on trim().is_empty(). A whitespace-only base
  // URL is therefore kept by one and defaulted by the other.
  ["EDGE: empty-string base url", { llmProvider: "anthropic", claudeApiKey: "sk-a", localBaseUrl: "", paneModels: { [PANE]: "llama3.1" } }],
  ["EDGE: whitespace-only base url — falsy vs trim", { llmProvider: "anthropic", claudeApiKey: "sk-a", localBaseUrl: "   ", paneModels: { [PANE]: "llama3.1" } }],
];

describe("paneLlmRouting fixtures", () => {
  it("captures paneLlmConfig over every rule", () => {
    const cases = SUBJECTS.map(([label, snap]) => ({
      label,
      paneModel: snap.paneModels?.[PANE] ?? null,
      // The RESOLVED global config is the Rust input — see the scope note above.
      global: paneLlmConfig(store({ ...snap, paneModels: {} }), PANE),
      expected: paneLlmConfig(store(snap), PANE),
    }));
    const next = {
      note: "GENERATED from @/app/console/lib/sessionLaunch paneLlmConfig — do not hand-edit; see the .gen.test.ts",
      tierModelIds: MODEL_IDS,
      cases,
    };

    if (process.env.UPDATE_FIXTURES) {
      writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    }
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("is non-vacuous: the shipped tiers are real and rule 4 actually re-routes", () => {
    expect(MODEL_IDS.length, "no shipped model tiers — data/console/models.json resolved to nothing").toBeGreaterThanOrEqual(3);
    const rerouted = paneLlmConfig(store({ llmProvider: "anthropic", claudeApiKey: "sk-a", paneModels: { [PANE]: "llama3.1" } }), PANE);
    expect(rerouted.provider, "rule 4 did not re-route — the fixture would prove nothing").toBe("ollama");
    expect(rerouted.apiKey, "the hosted key must not survive the reroute").toBe("");
  });
});
