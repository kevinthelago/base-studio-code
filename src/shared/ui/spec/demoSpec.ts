// The canonical end-to-end example (#1852 Phase 2) — the "LLM provider" settings card from the epic,
// authored purely as a node tree. This is the proof that a real card renders from a spec: it's used by
// the SDK test, and it doubles as the reference an agent copies when learning the contract.
//
// Rewritten in the GENERAL vocabulary (#3500). Every `type` names a REAL primitive from the shared
// manifest, so the example teaches the whole kit instead of the 8 shapes the renderer used to
// hardcode. All three wiring maps are on show, which is the point of using this as the reference:
//   - `props`   — plain data (labels, variants, options).
//   - `binds`   — a prop READ from host state (`value`, `on`).
//   - `actions` — a prop that is a host CALLBACK, named. The renderer forwards the handler's own
//                 arguments, so `onChange` receives the new value and the host can write it back.

import type { GeneralNode } from "./generalNode";

/** A real settings card expressed as data — provider select, API key, a stream toggle, a Save action. */
export const demoSpec: GeneralNode = {
  type: "Card",
  props: {
    tone: "var(--accent)",
    header: {
      type: "Row",
      props: { gap: "sm", align: "baseline" },
      children: [
        { type: "Text", props: { size: "md", weight: 600 }, children: "LLM provider" },
        { type: "Text", props: { tone: "dim", size: "sm" }, children: "API-tier" },
      ],
    },
  },
  children: [
    {
      type: "Stack",
      props: { gap: "sm" },
      children: [
        {
          type: "SelectField",
          props: {
            label: "Provider",
            children: [
              { type: "Option", props: { value: "anthropic" }, children: "anthropic" },
              { type: "Option", props: { value: "openai" }, children: "openai" },
            ],
          },
          binds: { value: "provider" },
          actions: { onChange: "setProvider" },
        },
        {
          type: "TextField",
          // `type` is a native <input> attribute, not a manifest prop — TextField is passthrough, so it
          // forwards. That is exactly what passthrough is for, and why the validator exempts it.
          props: { label: "API key", type: "password" },
          binds: { value: "apiKey" },
          actions: { onChange: "setApiKey" },
        },
        {
          type: "Row",
          props: { gap: "sm", justify: "between" },
          children: [
            { type: "Text", children: "Stream responses" },
            {
              type: "Toggle",
              props: { role: "switch" },
              binds: { on: "stream", ariaChecked: "stream" },
              actions: { onClick: "toggleStream" },
            },
          ],
        },
        {
          type: "Button",
          props: { variant: "primary" },
          children: "Save",
          actions: { onClick: "save" },
        },
      ],
    },
  ],
};
