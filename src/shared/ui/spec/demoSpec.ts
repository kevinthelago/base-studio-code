// The canonical end-to-end example (#1852 Phase 2) — the "LLM provider" settings card from the epic,
// authored purely as a `KitNode` tree. This is the proof that a real card renders from a spec: it's
// used by the SDK test, and it doubles as the reference an agent copies when learning the contract.

import type { CardNode } from "./schema";

/** A real settings card expressed as data — provider select, API key, a stream toggle, a Save action. */
export const demoSpec: CardNode = {
  kind: "card",
  tone: "var(--accent)",
  header: { kind: "header", title: "LLM provider", hint: "API-tier" },
  children: [
    { kind: "field", control: "select", label: "Provider", bind: "provider", options: ["anthropic", "openai"] },
    { kind: "field", control: "password", label: "API key", bind: "apiKey" },
    { kind: "row", label: "Stream responses", children: [{ kind: "toggle", bind: "stream" }] },
    { kind: "button", variant: "primary", label: "Save", action: "save" },
  ],
};
